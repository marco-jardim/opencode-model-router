import { describe, it, expect } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  tierRank,
  resolveStartTier,
  newLadderState,
  recordAttempt,
  nextTierAfter,
  buildLadderForcingMessage,
  nextAction,
  advance,
  buildEscalatePolicy,
  formatLadderScorecard,
  type EscalatePolicy,
  type LadderAction,
  type LadderState,
  type LadderVerdict,
} from "../../src/escalate/ladder";
import type { EffortLevel, Preset, RouterConfig, TierConfig } from "../../src/router/config";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makePolicy(overrides: Partial<EscalatePolicy> = {}): EscalatePolicy {
  return {
    ladder: ["fast", "medium", "heavy"],
    floorTier: null,
    maxAttemptsPerTier: 1,
    maxTotalAttempts: 4,
    costMultiple: null,
    ...overrides,
  };
}

function makeState(
  overrides: Partial<LadderState> = {},
): LadderState {
  const base: LadderState = {
    currentTier: "fast",
    attemptsThisTier: 0,
    totalAttempts: 0,
    escalations: 0,
    firstAttemptCost: null,
    cumulativeCost: 0,
  };
  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// tierRank
// ---------------------------------------------------------------------------

describe("tierRank", () => {
  const ladder = ["fast", "medium", "heavy"];

  it("returns correct index for known tier", () => {
    expect(tierRank("fast", ladder)).toBe(0);
    expect(tierRank("medium", ladder)).toBe(1);
    expect(tierRank("heavy", ladder)).toBe(2);
  });

  it("returns -1 for unknown tier", () => {
    expect(tierRank("ultra", ladder)).toBe(-1);
    expect(tierRank("", ladder)).toBe(-1);
  });

  it("returns -1 for empty ladder", () => {
    expect(tierRank("fast", [])).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// resolveStartTier
// ---------------------------------------------------------------------------

describe("resolveStartTier", () => {
  it("producer in ladder, no floor => returns producerTier", () => {
    const p = makePolicy({ ladder: ["fast", "medium", "heavy"] });
    expect(resolveStartTier("fast", p)).toBe("fast");
    expect(resolveStartTier("medium", p)).toBe("medium");
    expect(resolveStartTier("heavy", p)).toBe("heavy");
  });

  it("producer below floorTier => returns floorTier", () => {
    const p = makePolicy({
      ladder: ["fast", "medium", "heavy"],
      floorTier: "medium",
    });
    expect(resolveStartTier("fast", p)).toBe("medium");
  });

  it("producer at floorTier => returns producerTier (same)", () => {
    const p = makePolicy({
      ladder: ["fast", "medium", "heavy"],
      floorTier: "medium",
    });
    expect(resolveStartTier("medium", p)).toBe("medium");
  });

  it("producer above floorTier => returns producerTier", () => {
    const p = makePolicy({
      ladder: ["fast", "medium", "heavy"],
      floorTier: "fast",
    });
    expect(resolveStartTier("heavy", p)).toBe("heavy");
  });

  it("floorTier:heavy with producerTier:fast => starts at heavy", () => {
    const p = makePolicy({
      ladder: ["fast", "medium", "heavy"],
      floorTier: "heavy",
    });
    expect(resolveStartTier("fast", p)).toBe("heavy");
  });

  it("unknown producerTier not in ladder => uses ladder[0] unless floor raises it", () => {
    const p = makePolicy({
      ladder: ["fast", "medium", "heavy"],
      floorTier: null,
    });
    expect(resolveStartTier("unknown", p)).toBe("fast");
  });

  it("unknown producerTier + floor medium => starts at medium", () => {
    const p = makePolicy({
      ladder: ["fast", "medium", "heavy"],
      floorTier: "medium",
    });
    expect(resolveStartTier("unknown", p)).toBe("medium");
  });

  it("empty ladder, no floor => returns producerTier as fallback", () => {
    const p = makePolicy({ ladder: [], floorTier: null });
    expect(resolveStartTier("medium", p)).toBe("medium");
  });

  it("floorTier not in ladder (unknown) => acts as -1, no-op for floor", () => {
    const p = makePolicy({
      ladder: ["fast", "medium", "heavy"],
      floorTier: "nonexistent",
    });
    // fi=-1, pi=0 => startIdx=max(0,0)=0 => "fast"
    expect(resolveStartTier("fast", p)).toBe("fast");
  });
});

// ---------------------------------------------------------------------------
// newLadderState
// ---------------------------------------------------------------------------

describe("newLadderState", () => {
  it("initialises all counters to zero/null", () => {
    const p = makePolicy();
    const s = newLadderState("fast", p);
    expect(s.currentTier).toBe("fast");
    expect(s.attemptsThisTier).toBe(0);
    expect(s.totalAttempts).toBe(0);
    expect(s.escalations).toBe(0);
    expect(s.firstAttemptCost).toBeNull();
    expect(s.cumulativeCost).toBe(0);
  });

  it("applies floorTier to currentTier", () => {
    const p = makePolicy({ floorTier: "medium" });
    const s = newLadderState("fast", p);
    expect(s.currentTier).toBe("medium");
  });

  it("does not mutate input policy", () => {
    const p = makePolicy();
    const pCopy = JSON.parse(JSON.stringify(p)) as EscalatePolicy;
    newLadderState("fast", p);
    expect(p).toEqual(pCopy);
  });
});

// ---------------------------------------------------------------------------
// recordAttempt
// ---------------------------------------------------------------------------

describe("recordAttempt", () => {
  it("increments totalAttempts and cumulativeCost", () => {
    const s = makeState();
    const s2 = recordAttempt(s, 5);
    expect(s2.totalAttempts).toBe(1);
    expect(s2.cumulativeCost).toBe(5);
    expect(s2.firstAttemptCost).toBe(5);
  });

  it("firstAttemptCost is set only once (second call does not overwrite)", () => {
    const s = makeState();
    const s1 = recordAttempt(s, 3);
    const s2 = recordAttempt(s1, 10);
    expect(s2.firstAttemptCost).toBe(3);
    expect(s2.cumulativeCost).toBe(13);
    expect(s2.totalAttempts).toBe(2);
  });

  it("default cost is 0", () => {
    const s = makeState();
    const s2 = recordAttempt(s);
    expect(s2.cumulativeCost).toBe(0);
    expect(s2.firstAttemptCost).toBe(0);
  });

  it("does NOT mutate the input state", () => {
    const s = makeState({ totalAttempts: 0, cumulativeCost: 0 });
    recordAttempt(s, 7);
    expect(s.totalAttempts).toBe(0);
    expect(s.cumulativeCost).toBe(0);
  });

  it("accumulates cost across many calls", () => {
    let s = makeState();
    for (let i = 1; i <= 4; i++) {
      s = recordAttempt(s, i);
    }
    expect(s.cumulativeCost).toBe(10); // 1+2+3+4
    expect(s.firstAttemptCost).toBe(1);
    expect(s.totalAttempts).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// nextTierAfter
// ---------------------------------------------------------------------------

describe("nextTierAfter", () => {
  const p = makePolicy({ ladder: ["fast", "medium", "heavy"] });

  it("fast => medium", () => {
    expect(nextTierAfter("fast", p)).toBe("medium");
  });

  it("medium => heavy", () => {
    expect(nextTierAfter("medium", p)).toBe("heavy");
  });

  it("heavy (top) => null", () => {
    expect(nextTierAfter("heavy", p)).toBeNull();
  });

  it("unknown tier => null", () => {
    expect(nextTierAfter("unknown", p)).toBeNull();
  });

  it("single-tier ladder => null", () => {
    const single = makePolicy({ ladder: ["medium"] });
    expect(nextTierAfter("medium", single)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildLadderForcingMessage
// ---------------------------------------------------------------------------

describe("buildLadderForcingMessage", () => {
  it("includes header line", () => {
    const msg = buildLadderForcingMessage(["reason A"]);
    expect(msg).toContain(
      "[router escalation] previous attempt did not pass verification:",
    );
  });

  it("includes NEXT line", () => {
    const msg = buildLadderForcingMessage(["x"]);
    expect(msg).toContain("NEXT: retry with these failures addressed.");
  });

  it("formats each reason as a bullet", () => {
    const msg = buildLadderForcingMessage(["foo", "bar"]);
    expect(msg).toContain("- foo");
    expect(msg).toContain("- bar");
  });

  it("empty reasons => uses fallback bullet", () => {
    const msg = buildLadderForcingMessage([]);
    expect(msg).toContain("- (no reasons provided)");
    expect(msg).not.toContain("- foo");
  });

  it("multiple reasons all present in output", () => {
    const reasons = ["err1", "err2", "err3"];
    const msg = buildLadderForcingMessage(reasons);
    for (const r of reasons) {
      expect(msg).toContain(`- ${r}`);
    }
  });

  it("pure — does not include scrubbing (caller responsibility)", () => {
    const msg = buildLadderForcingMessage(["secret=abc123"]);
    // The raw text should pass through as-is
    expect(msg).toContain("secret=abc123");
  });
});

// ---------------------------------------------------------------------------
// nextAction — core decision logic
// ---------------------------------------------------------------------------

describe("nextAction", () => {
  it("verdict.pass=true => accept (immediate)", () => {
    const p = makePolicy();
    const s = makeState({ totalAttempts: 1 });
    const a = nextAction(s, { pass: true }, p);
    expect(a.action).toBe("accept");
  });

  it("verdict null => treated as FAIL (not accept)", () => {
    const p = makePolicy({ maxAttemptsPerTier: 2, maxTotalAttempts: 4 });
    const s = makeState({ totalAttempts: 1, attemptsThisTier: 0 });
    const a = nextAction(s, null, p);
    expect(a.action).not.toBe("accept");
  });

  it("verdict undefined => treated as FAIL (not accept)", () => {
    const p = makePolicy({ maxAttemptsPerTier: 2, maxTotalAttempts: 4 });
    const s = makeState({ totalAttempts: 1, attemptsThisTier: 0 });
    const a = nextAction(s, undefined, p);
    expect(a.action).not.toBe("accept");
  });

  it("maxTotalAttempts reached => give_up with message", () => {
    const p = makePolicy({ maxTotalAttempts: 3 });
    const s = makeState({ totalAttempts: 3, attemptsThisTier: 0 });
    const a = nextAction(s, { pass: false }, p);
    expect(a.action).toBe("give_up");
    expect(a.reason).toContain("max total attempts (3)");
  });

  it("maxTotalAttempts check precedes retry", () => {
    const p = makePolicy({ maxTotalAttempts: 2, maxAttemptsPerTier: 5 });
    // attemptsThisTier < maxAttemptsPerTier, but totalAttempts >= max
    const s = makeState({ totalAttempts: 2, attemptsThisTier: 0 });
    const a = nextAction(s, { pass: false }, p);
    expect(a.action).toBe("give_up");
  });

  it("cost ceiling exceeded => give_up", () => {
    const p = makePolicy({ costMultiple: 2, maxTotalAttempts: 10 });
    // first cost 5, cumulative 11 => 11 > 5*2=10
    const s = makeState({
      totalAttempts: 2,
      firstAttemptCost: 5,
      cumulativeCost: 11,
    });
    const a = nextAction(s, { pass: false }, p);
    expect(a.action).toBe("give_up");
    expect(a.reason).toBe("cost ceiling exceeded");
  });

  it("cost ceiling: cumulativeCost exactly at threshold (=) is NOT exceeded", () => {
    const p = makePolicy({ costMultiple: 2, maxTotalAttempts: 10 });
    // 5 * 2 = 10; cumulative = 10 => NOT exceeded (> not >=)
    const s = makeState({
      totalAttempts: 2,
      firstAttemptCost: 5,
      cumulativeCost: 10,
      attemptsThisTier: 0,
    });
    const a = nextAction(s, { pass: false }, p);
    expect(a.action).toBe("retry");
  });

  it("cost check precedes retry/escalate", () => {
    const p = makePolicy({
      costMultiple: 2,
      maxTotalAttempts: 10,
      maxAttemptsPerTier: 5,
    });
    const s = makeState({
      totalAttempts: 2,
      attemptsThisTier: 0,
      firstAttemptCost: 5,
      cumulativeCost: 11,
    });
    const a = nextAction(s, { pass: false }, p);
    expect(a.action).toBe("give_up");
  });

  it("retry when attemptsThisTier < maxAttemptsPerTier", () => {
    const p = makePolicy({ maxAttemptsPerTier: 2, maxTotalAttempts: 10 });
    const s = makeState({ totalAttempts: 1, attemptsThisTier: 0 });
    const a = nextAction(s, { pass: false }, p);
    expect(a.action).toBe("retry");
    expect(a.tier).toBe("fast");
    expect(a.forcingMessage).toBeDefined();
  });

  it("retry includes forcingMessage from verdict reasons", () => {
    const p = makePolicy({ maxAttemptsPerTier: 3, maxTotalAttempts: 10 });
    const s = makeState({ totalAttempts: 1, attemptsThisTier: 0 });
    const verdict: LadderVerdict = { pass: false, reasons: ["bad output"] };
    const a = nextAction(s, verdict, p);
    expect(a.action).toBe("retry");
    expect(a.forcingMessage).toContain("bad output");
  });

  it("escalate when attemptsThisTier >= maxAttemptsPerTier and next tier exists", () => {
    const p = makePolicy({ maxAttemptsPerTier: 1, maxTotalAttempts: 10 });
    const s = makeState({
      currentTier: "fast",
      totalAttempts: 1,
      attemptsThisTier: 1,
    });
    const a = nextAction(s, { pass: false }, p);
    expect(a.action).toBe("escalate");
    expect(a.tier).toBe("medium");
    expect(a.forcingMessage).toBeDefined();
  });

  it("give_up: no higher tier (already at top)", () => {
    const p = makePolicy({ maxAttemptsPerTier: 1, maxTotalAttempts: 10 });
    const s = makeState({
      currentTier: "heavy",
      totalAttempts: 1,
      attemptsThisTier: 1,
    });
    const a = nextAction(s, { pass: false }, p);
    expect(a.action).toBe("give_up");
    expect(a.reason).toBe("no higher tier (already at top of ladder)");
  });

  it("maxAttemptsPerTier:0 => escalate immediately (no retry)", () => {
    const p = makePolicy({
      maxAttemptsPerTier: 0,
      maxTotalAttempts: 10,
      ladder: ["fast", "medium", "heavy"],
    });
    const s = makeState({
      currentTier: "fast",
      totalAttempts: 1,
      attemptsThisTier: 0,
    });
    const a = nextAction(s, { pass: false }, p);
    expect(a.action).toBe("escalate");
    expect(a.tier).toBe("medium");
  });

  it("single-tier ladder: retries up to cap then give_up (no escalate)", () => {
    const p = makePolicy({
      ladder: ["medium"],
      maxAttemptsPerTier: 2,
      maxTotalAttempts: 10,
    });
    const s = makeState({
      currentTier: "medium",
      totalAttempts: 3,
      attemptsThisTier: 2,
    });
    const a = nextAction(s, { pass: false }, p);
    expect(a.action).toBe("give_up");
    expect(a.reason).toBe("no higher tier (already at top of ladder)");
  });

  it("no forcingMessage on give_up", () => {
    const p = makePolicy({ maxTotalAttempts: 1 });
    const s = makeState({ totalAttempts: 1 });
    const a = nextAction(s, { pass: false }, p);
    expect(a.action).toBe("give_up");
    expect(a.forcingMessage).toBeUndefined();
  });

  it("costMultiple null => cost check never triggers", () => {
    const p = makePolicy({ costMultiple: null, maxTotalAttempts: 10, maxAttemptsPerTier: 1 });
    const s = makeState({
      totalAttempts: 2,
      attemptsThisTier: 0,
      firstAttemptCost: 1,
      cumulativeCost: 99999,
    });
    const a = nextAction(s, { pass: false }, p);
    // Should NOT give_up due to cost (costMultiple is null)
    expect(a.action).not.toBe("give_up");
  });

  it("firstAttemptCost null => cost check never triggers even with costMultiple set", () => {
    const p = makePolicy({ costMultiple: 2, maxTotalAttempts: 10, maxAttemptsPerTier: 3 });
    const s = makeState({
      totalAttempts: 1,
      attemptsThisTier: 0,
      firstAttemptCost: null,
      cumulativeCost: 100,
    });
    const a = nextAction(s, { pass: false }, p);
    expect(a.action).not.toBe("give_up");
  });

  it("accept takes priority over cost/attempt checks", () => {
    const p = makePolicy({ costMultiple: 1, maxTotalAttempts: 1 });
    const s = makeState({
      totalAttempts: 5,
      firstAttemptCost: 1,
      cumulativeCost: 100,
    });
    const a = nextAction(s, { pass: true }, p);
    expect(a.action).toBe("accept");
  });
});

// ---------------------------------------------------------------------------
// advance — state transitions
// ---------------------------------------------------------------------------

describe("advance", () => {
  it("retry => increments attemptsThisTier only", () => {
    const s = makeState({ attemptsThisTier: 0, currentTier: "fast" });
    const s2 = advance(s, { action: "retry", tier: "fast" });
    expect(s2.attemptsThisTier).toBe(1);
    expect(s2.currentTier).toBe("fast");
    expect(s2.escalations).toBe(0);
    expect(s2.totalAttempts).toBe(0); // unchanged
  });

  it("escalate => updates currentTier, resets attemptsThisTier, increments escalations", () => {
    const s = makeState({
      currentTier: "fast",
      attemptsThisTier: 1,
      escalations: 0,
    });
    const s2 = advance(s, { action: "escalate", tier: "medium" });
    expect(s2.currentTier).toBe("medium");
    expect(s2.attemptsThisTier).toBe(0);
    expect(s2.escalations).toBe(1);
  });

  it("accept => state unchanged (terminal)", () => {
    const s = makeState({ currentTier: "medium", totalAttempts: 3 });
    const s2 = advance(s, { action: "accept" });
    expect(s2).toEqual(s);
  });

  it("give_up => state unchanged (terminal)", () => {
    const s = makeState({ totalAttempts: 4, currentTier: "heavy" });
    const s2 = advance(s, { action: "give_up", reason: "done" });
    expect(s2).toEqual(s);
  });

  it("does NOT mutate input state on retry", () => {
    const s = makeState({ attemptsThisTier: 2 });
    const orig = { ...s };
    advance(s, { action: "retry", tier: "fast" });
    expect(s.attemptsThisTier).toBe(orig.attemptsThisTier);
  });

  it("does NOT mutate input state on escalate", () => {
    const s = makeState({ currentTier: "fast", escalations: 0 });
    const orig = { ...s };
    advance(s, { action: "escalate", tier: "medium" });
    expect(s.currentTier).toBe(orig.currentTier);
    expect(s.escalations).toBe(orig.escalations);
  });
});

// ---------------------------------------------------------------------------
// buildEscalatePolicy
// ---------------------------------------------------------------------------

describe("buildEscalatePolicy", () => {
  function makeCfg(partial: Partial<RouterConfig> = {}): RouterConfig {
    return {
      activePreset: "default",
      presets: {},
      rules: [],
      defaultTier: "fast",
      ...partial,
    } as RouterConfig;
  }

  it("all defaults when enforcement is absent", () => {
    const p = buildEscalatePolicy(makeCfg());
    expect(p.ladder).toEqual(["fast", "medium", "heavy"]);
    expect(p.floorTier).toBeNull();
    expect(p.maxAttemptsPerTier).toBe(1);
    expect(p.maxTotalAttempts).toBe(4);
    expect(p.costMultiple).toBe(4);
  });

  it("honours cfg.enforcement.escalate overrides", () => {
    const cfg = makeCfg({
      enforcement: {
        escalate: {
          ladder: ["a", "b"],
          floorTier: "b",
          maxAttemptsPerTier: 3,
          maxTotalAttempts: 8,
          costCeiling: { multiple: 5 },
        },
      },
    });
    const p = buildEscalatePolicy(cfg);
    expect(p.ladder).toEqual(["a", "b"]);
    expect(p.floorTier).toBe("b");
    expect(p.maxAttemptsPerTier).toBe(3);
    expect(p.maxTotalAttempts).toBe(8);
    expect(p.costMultiple).toBe(5);
  });

  it("enforcement present but escalate absent => defaults", () => {
    const cfg = makeCfg({ enforcement: { mode: "enforced" } });
    const p = buildEscalatePolicy(cfg);
    expect(p.ladder).toEqual(["fast", "medium", "heavy"]);
    expect(p.maxTotalAttempts).toBe(4);
  });

  it("partial escalate config => merges defaults for missing fields", () => {
    const cfg = makeCfg({
      enforcement: { escalate: { maxTotalAttempts: 6 } },
    });
    const p = buildEscalatePolicy(cfg);
    expect(p.maxTotalAttempts).toBe(6);
    expect(p.ladder).toEqual(["fast", "medium", "heavy"]);
    expect(p.maxAttemptsPerTier).toBe(1);
    expect(p.costMultiple).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Per-tier effort bump policy construction
// ---------------------------------------------------------------------------

describe("buildEscalatePolicy effort bump", () => {
  function makeCfg(
    tiers: Preset,
    escalate: NonNullable<RouterConfig["enforcement"]>["escalate"] = {},
  ): RouterConfig {
    return {
      activePreset: "test",
      presets: { test: tiers },
      rules: [],
      defaultTier: "fast",
      enforcement: { escalate },
    };
  }

  function shippedCfg(activePreset: string): RouterConfig {
    const cfg: RouterConfig = JSON.parse(readFileSync(new URL("../../tiers.json", import.meta.url), "utf8"));
    return { ...cfg, activePreset };
  }

  const claude = { model: "anthropic/claude-sonnet-4-5", effort: "high" } satisfies TierConfig;
  const openai = { model: "openai/gpt-5", effort: "medium" } satisfies TierConfig;

  it.each([
    ["no effort", { model: claude.model }],
    ["variant", { ...claude, variant: "high" }],
    ["unknown provider", { model: "other/model", effort: "low" }],
    ["winning thinking budget", { ...claude, thinking: { budgetTokens: 4096 } }],
    ["winning reasoning effort", { ...openai, reasoning: { effort: "low" } }],
    ["Claude at default max", { ...claude, effort: "xhigh" }],
    ["OpenAI at its ceiling", { ...openai, effort: "high" }],
  ] satisfies Array<[string, TierConfig]>)("excludes a tier with %s", (_name, tier) => {
    expect(buildEscalatePolicy(makeCfg({ fast: tier }))).not.toHaveProperty("effortBump");
  });

  it.each([
    ["invalid effort", { ...claude, effort: "ultra" }],
    ["wrong-case effort", { ...claude, effort: "High" }],
    ["null effort", { ...claude, effort: null }],
    ["missing model", { effort: "low" }],
    ["non-string model", { model: 42, effort: "low" }],
    ["null entry", null],
  ])("skips malformed runtime config: %s", (_name, tier) => {
    const cfg: RouterConfig = JSON.parse(JSON.stringify({
      ...makeCfg({}), presets: { test: { fast: tier } },
    }));
    expect(buildEscalatePolicy(cfg)).not.toHaveProperty("effortBump");
  });

  it("bounds OpenAI medium at high and Claude high at the default xhigh", () => {
    expect(buildEscalatePolicy(makeCfg({ fast: openai, medium: claude })).effortBump).toEqual({
      perTier: {
        fast: { base: "medium", bound: "high" },
        medium: { base: "high", bound: "xhigh" },
      },
    });
  });

  it("omits the key when disabled even with eligible tiers", () => {
    expect(buildEscalatePolicy(makeCfg({ fast: openai, medium: claude }, { effortBump: false })))
      .not.toHaveProperty("effortBump");
  });

  it("max low disables every tier, including one starting at low", () => {
    const cfg = makeCfg({ fast: { ...claude, effort: "low" }, medium: openai, heavy: claude }, { effortBumpMax: "low" });
    expect(buildEscalatePolicy(cfg)).not.toHaveProperty("effortBump");
  });

  it("max high excludes Claude high but still bumps OpenAI medium", () => {
    expect(buildEscalatePolicy(makeCfg({ fast: openai, medium: claude }, { effortBumpMax: "high" })).effortBump)
      .toEqual({ perTier: { fast: { base: "medium", bound: "high" } } });
  });

  it("max max allows Claude high through max, without raising the OpenAI ceiling", () => {
    expect(buildEscalatePolicy(makeCfg({ fast: openai, medium: claude }, { effortBumpMax: "max" })).effortBump)
      .toEqual({ perTier: {
        fast: { base: "medium", bound: "high" },
        medium: { base: "high", bound: "max" },
      } });
  });

  it("includes off-ladder tiers and stores prototype-named tiers as safe own entries", () => {
    const names = ["custom", "__proto__", "constructor", "toString"];
    const cfg = makeCfg(Object.fromEntries(names.map((name) => [name, claude])));
    const before = JSON.stringify(cfg);
    const perTier = buildEscalatePolicy(cfg).effortBump!.perTier;
    expect(Object.keys(perTier)).toEqual(names);
    expect(Object.getPrototypeOf(perTier)).toBe(Object.prototype);
    for (const name of names) {
      expect(Object.prototype.hasOwnProperty.call(perTier, name)).toBe(true);
      expect(perTier[name]).toEqual({ base: "high", bound: "xhigh" });
    }
    expect(JSON.stringify(cfg)).toBe(before);
  });

  it("omits the key for empty presets without crashing", () => {
    expect(buildEscalatePolicy({ ...makeCfg({}), presets: {} })).not.toHaveProperty("effortBump");
  });

  it("shipped anthropic preset has no eligible tiers because all have variants", () => {
    const cfg = shippedCfg("anthropic");
    expect(Object.values(cfg.presets.anthropic!).every((tier) => Boolean(tier.variant))).toBe(true);
    expect(buildEscalatePolicy(cfg)).not.toHaveProperty("effortBump");
  });

  it("shipped fable-effort preset bumps fast and medium but excludes heavy", () => {
    expect(buildEscalatePolicy(shippedCfg("fable-effort")).effortBump).toEqual({
      perTier: {
        fast: { base: "low", bound: "xhigh" },
        medium: { base: "high", bound: "xhigh" },
      },
    });
  });

  it("runs the fable-effort fail stream with recorded tier costs and a final scorecard", () => {
    const cfg = shippedCfg("fable-effort");
    // Allow four attempts at the shipped ratios (1, 1, 3, 3); the default
    // multiple of four would stop after the first medium attempt costs five.
    cfg.enforcement = { ...cfg.enforcement, escalate: {
      ...cfg.enforcement?.escalate, costCeiling: { multiple: 8 },
    } };
    const policy = buildEscalatePolicy(cfg);
    const tiers = cfg.presets["fable-effort"]!;
    let state = newLadderState("fast", policy);
    const attempts: string[] = [];
    const actions: string[] = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      const tier = tiers[state.currentTier]!;
      attempts.push(`${state.currentTier}@${state.currentEffort ?? tier.effort}`);
      state = recordAttempt(state, tier.costRatio);
      const action = nextAction(state, { pass: false, outcome: "fail", reasons: ["check failed"] }, policy);
      actions.push(action.action);
      if (attempt === 3) expect(action).toEqual({ action: "give_up", reason: "max total attempts (4) reached" });
      state = advance(state, action);
    }
    expect(attempts).toEqual(["fast@low", "fast@medium", "medium@high", "medium@xhigh"]);
    expect(actions).toEqual(["retry", "escalate", "retry", "give_up"]);
    expect(state.firstAttemptCost).toBe(1);
    expect(formatLadderScorecard(state, false, "trace")).toBe(
      "[router delegate scorecard | final_tier=medium@xhigh | attempts=4 | escalations=1 | cost=8 | verdict=UNMET | method=trace]",
    );
  });
});

// ---------------------------------------------------------------------------
// Edge-case integration scenarios
// ---------------------------------------------------------------------------

describe("edge cases: explicit scenario coverage", () => {
  it("FAIL at heavy with no retries left => give_up 'no higher tier'", () => {
    const p = makePolicy({ maxAttemptsPerTier: 1, maxTotalAttempts: 10 });
    const s = makeState({
      currentTier: "heavy",
      totalAttempts: 1,
      attemptsThisTier: 1,
    });
    const a = nextAction(s, { pass: false }, p);
    expect(a.action).toBe("give_up");
    expect(a.reason).toBe("no higher tier (already at top of ladder)");
  });

  it("maxTotalAttempts reached mid-ladder => give_up 'max total attempts'", () => {
    const p = makePolicy({ maxTotalAttempts: 2, maxAttemptsPerTier: 5 });
    const s = makeState({ currentTier: "medium", totalAttempts: 2, attemptsThisTier: 0 });
    const a = nextAction(s, { pass: false }, p);
    expect(a.action).toBe("give_up");
    expect(a.reason).toContain("max total attempts (2)");
  });

  it("cost ceiling exceeded mid-ladder => give_up 'cost ceiling exceeded'", () => {
    const p = makePolicy({ costMultiple: 3, maxTotalAttempts: 10 });
    const s = makeState({
      totalAttempts: 2,
      firstAttemptCost: 4,
      cumulativeCost: 13, // 13 > 4*3=12
      attemptsThisTier: 0,
    });
    const a = nextAction(s, { pass: false }, p);
    expect(a.action).toBe("give_up");
    expect(a.reason).toBe("cost ceiling exceeded");
  });

  it("retry then PASS => accept on second call", () => {
    const p = makePolicy({ maxAttemptsPerTier: 2, maxTotalAttempts: 10 });
    let s = newLadderState("fast", p);
    s = recordAttempt(s, 1);
    const a1 = nextAction(s, { pass: false }, p);
    expect(a1.action).toBe("retry");
    s = advance(s, a1);
    s = recordAttempt(s, 1);
    const a2 = nextAction(s, { pass: true }, p);
    expect(a2.action).toBe("accept");
  });

  it("maxAttemptsPerTier:0 => escalate immediately on first FAIL", () => {
    const p = makePolicy({ maxAttemptsPerTier: 0, maxTotalAttempts: 10 });
    let s = newLadderState("fast", p);
    s = recordAttempt(s, 0);
    const a = nextAction(s, { pass: false }, p);
    expect(a.action).toBe("escalate");
    expect(a.tier).toBe("medium");
  });

  it("single-tier ladder ['medium'] => retries up to cap then give_up (no escalate target)", () => {
    const p = makePolicy({
      ladder: ["medium"],
      maxAttemptsPerTier: 2,
      maxTotalAttempts: 10,
    });
    let s = newLadderState("medium", p);
    // First attempt
    s = recordAttempt(s, 1);
    const a1 = nextAction(s, { pass: false }, p);
    expect(a1.action).toBe("retry"); // attemptsThisTier(0) < 2
    s = advance(s, a1);
    // Second attempt
    s = recordAttempt(s, 1);
    const a2 = nextAction(s, { pass: false }, p);
    expect(a2.action).toBe("retry"); // attemptsThisTier(1) < 2
    s = advance(s, a2);
    // Third attempt — exhausted tier
    s = recordAttempt(s, 1);
    const a3 = nextAction(s, { pass: false }, p);
    expect(a3.action).toBe("give_up");
    expect(a3.reason).toBe("no higher tier (already at top of ladder)");
  });

  it("floorTier:'heavy' with producerTier 'fast' => starts at heavy (no cheap rungs)", () => {
    const p = makePolicy({ floorTier: "heavy" });
    const s = newLadderState("fast", p);
    expect(s.currentTier).toBe("heavy");
  });

  it("producerTier below floorTier => starts at floorTier", () => {
    const p = makePolicy({ floorTier: "medium" });
    const s = newLadderState("fast", p);
    expect(s.currentTier).toBe("medium");
  });

  it("unknown producerTier not in ladder => starts at ladder[0]", () => {
    const p = makePolicy({ floorTier: null });
    const s = newLadderState("turbo", p);
    expect(s.currentTier).toBe("fast");
  });

  it("verdict null/undefined => treated as FAIL (not accept)", () => {
    const p = makePolicy({ maxAttemptsPerTier: 2, maxTotalAttempts: 10 });
    const s = makeState({ totalAttempts: 1, attemptsThisTier: 0 });
    expect(nextAction(s, null, p).action).not.toBe("accept");
    expect(nextAction(s, undefined, p).action).not.toBe("accept");
  });

  it("recordAttempt: sets firstAttemptCost once and accumulates cumulativeCost", () => {
    let s = makeState();
    s = recordAttempt(s, 7);
    expect(s.firstAttemptCost).toBe(7);
    s = recordAttempt(s, 3);
    expect(s.firstAttemptCost).toBe(7); // unchanged
    expect(s.cumulativeCost).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// formatLadderScorecard
// ---------------------------------------------------------------------------

describe("formatLadderScorecard", () => {
  it("accepted=true => verdict=PASS with all fields present", () => {
    const p = makePolicy({ ladder: ["fast", "medium", "heavy"] });
    let s = newLadderState("fast", p);
    s = recordAttempt(s, 3);
    s = advance(s, { action: "escalate", tier: "medium" });
    s = recordAttempt(s, 5);
    const result = formatLadderScorecard(s, true, "grader");
    expect(result).toContain("verdict=PASS");
    expect(result).toContain(`final_tier=${s.currentTier}`);
    expect(result).toContain(`attempts=${s.totalAttempts}`);
    expect(result).toContain(`escalations=${s.escalations}`);
    expect(result).toContain(`cost=${s.cumulativeCost}`);
    expect(result).toContain("method=grader");
  });

  it("accepted=false => verdict=UNMET", () => {
    const p = makePolicy();
    const s = newLadderState("fast", p);
    const result = formatLadderScorecard(s, false, "heuristic");
    expect(result).toContain("verdict=UNMET");
    expect(result).not.toContain("verdict=PASS");
  });
});

// ---------------------------------------------------------------------------
// Effort step — hand-built policies isolate the state machine from construction.
// ---------------------------------------------------------------------------

describe("ladder effort step", () => {
  const fail: LadderVerdict = { pass: false, outcome: "fail", reasons: ["check failed"] };

  function bumpPolicy(overrides: Partial<EscalatePolicy> = {}): EscalatePolicy {
    return makePolicy({
      effortBump: {
        perTier: {
          fast: { base: "low", bound: "high" },
          medium: { base: "medium", bound: "high" },
        },
      },
      ...overrides,
    });
  }

  it.each(["medium", "high", "xhigh"] as const)("replays the four-attempt D8 trace with fast bound %s", (bound) => {
    const policy = bumpPolicy({
      effortBump: { perTier: {
        fast: { base: "low", bound },
        medium: { base: "medium", bound: "high" },
      } },
    });
    let state = newLadderState("fast", policy);
    const trace = [
      { tier: "fast", currentEffort: null, effective: "low", action: "retry", effort: "medium" },
      { tier: "fast", currentEffort: "medium", effective: "medium", action: "escalate", effort: undefined },
      { tier: "medium", currentEffort: null, effective: "medium", action: "retry", effort: "high" },
      { tier: "medium", currentEffort: "high", effective: "high", action: "give_up", effort: undefined },
    ];
    const attempts: string[] = [];
    for (const step of trace) {
      expect(state.currentTier).toBe(step.tier);
      expect(state.currentEffort).toBe(step.currentEffort);
      const base = policy.effortBump!.perTier[state.currentTier]!.base;
      expect(state.currentEffort ?? base).toBe(step.effective);
      attempts.push(`${state.currentTier}@${state.currentEffort ?? base}`);
      state = recordAttempt(state, 1);
      expect(state.currentEffort).toBe(step.currentEffort);
      const suffix = step.currentEffort ? `@${step.currentEffort}` : "";
      expect(formatLadderScorecard(state, false, "trace")).toContain(`final_tier=${step.tier}${suffix} |`);
      const action = nextAction(state, fail, policy);
      expect(action.action).toBe(step.action);
      expect(action.effort).toBe(step.effort);
      if (step.effort === undefined) expect(action).not.toHaveProperty("effort");
      if (action.action === "give_up") {
        expect(action.reason).toBe("max total attempts (4) reached");
        expect(advance(state, action)).toBe(state);
      }
      state = advance(state, action);
      expect(state.currentEffort).toBe(
        step.action === "escalate" ? null : step.effort ?? step.currentEffort,
      );
    }
    expect(attempts).toEqual(["fast@low", "fast@medium", "medium@medium", "medium@high"]);
    expect(formatLadderScorecard(state, false, "trace")).toBe(
      "[router delegate scorecard | final_tier=medium@high | attempts=4 | escalations=1 | cost=4 | verdict=UNMET | method=trace]",
    );
  });

  it("two retries reach high; a further permitted retry stays high", () => {
    const policy = bumpPolicy({ maxAttemptsPerTier: 2, maxTotalAttempts: 10 });
    let state = newLadderState("fast", policy);
    expect(state.currentEffort).toBeNull(); // configured low
    for (const effort of ["medium", "high"]) {
      state = recordAttempt(state, 1);
      const action = nextAction(state, fail, policy);
      expect(action).toMatchObject({ action: "retry", tier: "fast", effort });
      state = advance(state, action);
      expect(state.currentEffort).toBe(effort);
    }
    state = recordAttempt(state, 1);
    const escalation = nextAction(state, fail, policy);
    expect(escalation).toMatchObject({ action: "escalate", tier: "medium" });
    expect(escalation).not.toHaveProperty("effort");
    expect(advance(state, escalation).currentEffort).toBeNull();
    // A=2 exhausts the tier. Saturation applies only if another retry is allowed.
    const retry = nextAction(state, fail, { ...policy, maxAttemptsPerTier: 3 });
    expect(retry).toMatchObject({ action: "retry", effort: "high" });
    expect(advance(state, retry).currentEffort).toBe("high");
  });

  it("saturates both retries at xhigh when the base is high", () => {
    const policy = bumpPolicy({
      maxAttemptsPerTier: 2,
      effortBump: { perTier: { fast: { base: "high", bound: "xhigh" } } },
    });
    let state = newLadderState("fast", policy);
    for (let retry = 0; retry < 2; retry++) {
      state = recordAttempt(state, 1);
      const action = nextAction(state, fail, policy);
      expect(action).toMatchObject({ action: "retry", effort: "xhigh" });
      state = advance(state, action);
      expect(state.currentEffort).toBe("xhigh");
    }
  });

  it("zero retries escalates directly without bumping", () => {
    const policy = bumpPolicy({ maxAttemptsPerTier: 0 });
    const state = recordAttempt(newLadderState("fast", policy), 1);
    const action = nextAction(state, fail, policy);
    expect(action).toMatchObject({ action: "escalate", tier: "medium" });
    expect(action).not.toHaveProperty("effort");
    expect(advance(state, action).currentEffort).toBeNull();
  });

  it("cost ceiling blocks bumped and plain retries with the same reason", () => {
    const policy = bumpPolicy({ costMultiple: 2, maxTotalAttempts: 10, maxAttemptsPerTier: 3 });
    const first = recordAttempt(newLadderState("fast", policy), 5);
    const bumped = advance(first, nextAction(first, fail, policy));
    const atCeiling = recordAttempt(bumped, 5);
    expect(nextAction(atCeiling, fail, policy)).toMatchObject({ action: "retry", effort: "high" });
    const aboveCeiling = recordAttempt(atCeiling, 1);
    const action = nextAction(aboveCeiling, fail, policy);
    expect(action).toEqual({ action: "give_up", reason: "cost ceiling exceeded" });
    expect(action).toEqual(nextAction(aboveCeiling, fail, { ...policy, effortBump: null }));
    expect(action).not.toHaveProperty("effort");
  });

  it("keeps pass, unverifiable, total-attempt and cost checks ahead of the bump", () => {
    const policy = bumpPolicy({ maxTotalAttempts: 1, costMultiple: 1 });
    const state = makeState({ totalAttempts: 1, firstAttemptCost: 1, cumulativeCost: 2, currentEffort: "medium" });
    for (const [verdict, expected] of [
      [{ pass: true }, { action: "accept" }],
      [{ pass: false, outcome: "unverifiable" }, { action: "give_up", reason: "verification unavailable; no producer escalation" }],
      [fail, { action: "give_up", reason: "max total attempts (1) reached" }],
    ] satisfies Array<[LadderVerdict, LadderAction]>) {
      const action = nextAction(state, verdict, policy);
      expect(action).toEqual(expected);
      expect(action).not.toHaveProperty("effort");
      expect(advance(state, action)).toBe(state);
    }
    const available = recordAttempt(newLadderState("fast", bumpPolicy()), 1);
    expect(nextAction(available, { pass: false, outcome: "unverifiable" }, bumpPolicy())).toEqual({
      action: "give_up", reason: "verification unavailable; no producer escalation",
    });
  });

  it("starts at the floor and bumps that tier rather than the producer", () => {
    const policy = bumpPolicy({ floorTier: "medium" });
    const state = recordAttempt(newLadderState("fast", policy), 1);
    expect(state).toMatchObject({ currentTier: "medium", currentEffort: null });
    const action = nextAction(state, fail, policy);
    expect(action).toMatchObject({ action: "retry", tier: "medium", effort: "high" });
    expect(advance(state, action).currentEffort).toBe("high");
  });

  it.each([undefined, null] as const)("base equal to bound leaves an unbumped state (%s) plain", (currentEffort) => {
    const policy = bumpPolicy({ effortBump: { perTier: { fast: { base: "high", bound: "high" } } } });
    const state = currentEffort === undefined ? makeState() : makeState({ currentEffort });
    const action = nextAction(state, fail, policy);
    expect(action.action).toBe("retry");
    expect(action).not.toHaveProperty("effort");
    const advanced = advance(state, action);
    expect(advanced).toEqual({ ...state, attemptsThisTier: 1 });
    expect(formatLadderScorecard(advanced, false, "test")).toContain("final_tier=fast |");
    if (currentEffort === undefined) expect(advanced).not.toHaveProperty("currentEffort");
  });

  it.each(["heavy", "constructor", "__proto__", "toString"])("missing own perTier entry for %s gives a plain retry", (tier) => {
    const policy = bumpPolicy({ ladder: [tier] });
    const state = recordAttempt(newLadderState(tier, policy), 1);
    const action = nextAction(state, fail, policy);
    expect(action).toMatchObject({ action: "retry", tier });
    expect(action).not.toHaveProperty("effort");
    expect(advance(state, action).currentEffort).toBeNull();
    expect(formatLadderScorecard(advance(state, action), false, "test")).toContain(`final_tier=${tier} |`);
    // A retry without an override preserves even an existing effort value.
    expect(advance({ ...state, currentEffort: "high" }, action).currentEffort).toBe("high");
  });

  it("accepts a bumped retry and reports the final attempt's effort", () => {
    const policy = bumpPolicy();
    let state = recordAttempt(newLadderState("fast", policy), 1);
    state = recordAttempt(advance(state, nextAction(state, fail, policy)), 1);
    const action = nextAction(state, { pass: true }, policy);
    expect(action).toEqual({ action: "accept" });
    expect(advance(state, action)).toBe(state);
    expect(formatLadderScorecard(state, true, "test")).toBe(
      "[router delegate scorecard | final_tier=fast@medium | attempts=2 | escalations=0 | cost=2 | verdict=PASS | method=test]",
    );
  });

  it("effort never decreases within a tier or exceeds its bound across all valid base/bound pairs", () => {
    const levels: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
    for (const [baseRank, base] of levels.entries()) {
      for (const bound of levels.slice(baseRank)) {
        const policy = bumpPolicy({
          maxAttemptsPerTier: 6, maxTotalAttempts: 10,
          effortBump: { perTier: { fast: { base, bound } } },
        });
        // Legacy states without currentEffort also start from the configured base.
        let state = makeState();
        let previousRank = baseRank;
        for (let retry = 0; retry < 6; retry++) {
          state = recordAttempt(state, 1);
          const action = nextAction(state, fail, policy);
          const expectedRank = Math.min(previousRank + 1, levels.indexOf(bound));
          expect(action.action).toBe("retry");
          expect(action.effort ?? base).toBe(levels[expectedRank]);
          state = advance(state, action);
          const rank = levels.indexOf(state.currentEffort ?? base);
          expect(rank).toBe(expectedRank);
          expect(rank).toBeGreaterThanOrEqual(previousRank);
          expect(rank).toBeLessThanOrEqual(levels.indexOf(bound));
          previousRank = rank;
        }
        const escalation = nextAction(state, fail, policy);
        expect(escalation).toMatchObject({ action: "escalate", tier: "medium" });
        expect(escalation).not.toHaveProperty("effort");
        expect(advance(state, escalation).currentEffort ?? null).toBeNull();
      }
    }
  });

  it("does not mutate frozen policy, state, verdict or actions", () => {
    const policy = bumpPolicy();
    for (const entry of Object.values(policy.effortBump!.perTier)) Object.freeze(entry);
    Object.freeze(policy.effortBump!.perTier);
    Object.freeze(policy.effortBump);
    Object.freeze(policy.ladder);
    Object.freeze(policy);
    const before = JSON.stringify(policy);
    const reasons = ["check failed"];
    Object.freeze(reasons);
    const verdict = Object.freeze({ ...fail, reasons });
    const initial = Object.freeze(newLadderState("fast", policy));
    const state = Object.freeze(recordAttempt(initial, 1));
    const stateBefore = JSON.stringify(state);
    const retry = Object.freeze(nextAction(state, verdict, policy));
    const retryBefore = JSON.stringify(retry);
    expect(retry.effort).toBe("medium");
    const bumped = Object.freeze(advance(state, retry));
    const escalation = Object.freeze(nextAction(bumped, verdict, policy));
    const escalationBefore = JSON.stringify(escalation);
    expect(advance(bumped, escalation).currentEffort).toBeNull();
    expect(bumped.currentEffort).toBe("medium");
    expect(initial).toMatchObject({ totalAttempts: 0, currentEffort: null });
    expect(JSON.stringify(state)).toBe(stateBefore);
    expect(JSON.stringify(policy)).toBe(before);
    expect(JSON.stringify(retry)).toBe(retryBefore);
    expect(JSON.stringify(escalation)).toBe(escalationBefore);
  });
});

// ---------------------------------------------------------------------------
// Property-based: termination guarantee
// ---------------------------------------------------------------------------

describe("property-based: termination", () => {
  for (let seed = 1; seed <= 60; seed++) {
    it(`seed=${seed}: loop always terminates and invariants hold`, () => {
      const rng = mulberry32(seed);

      // Random but valid policy
      const ladderLen = 1 + Math.floor(rng() * 3); // 1..3
      const allTiers = ["fast", "medium", "heavy", "ultra"];
      const ladder = allTiers.slice(0, ladderLen);
      const maxAttemptsPerTier = Math.floor(rng() * 4); // 0..3
      const maxTotalAttempts = 1 + Math.floor(rng() * 6); // 1..6
      const useCostMultiple = rng() < 0.5;
      const costMultiple: number | null = useCostMultiple
        ? 1 + Math.floor(rng() * 5) // 1..5
        : null;

      const p: EscalatePolicy = {
        ladder,
        floorTier: null,
        maxAttemptsPerTier,
        maxTotalAttempts,
        costMultiple,
      };

      const producerTier = ladder[0]!;
      let state = newLadderState(producerTier, p);
      let cycles = 0;
      let done = false;
      let prevTotalAttempts = 0;
      let prevEscalations = 0;

      while (!done) {
        // Simulate random per-attempt cost 0..10
        const cost = Math.floor(rng() * 11);
        state = recordAttempt(state, cost);
        cycles++;

        // Monotonic: totalAttempts strictly increases each cycle
        expect(state.totalAttempts).toBeGreaterThan(prevTotalAttempts);
        prevTotalAttempts = state.totalAttempts;

        // Random verdict (including all-FAIL case)
        const pass = rng() < 0.3; // 30% chance pass
        const verdict: LadderVerdict = {
          pass,
          reasons: pass ? [] : ["failure reason"],
        };

        const action = nextAction(state, verdict, p);

        // nextAction NEVER returns retry/escalate when totalAttempts >= maxTotalAttempts
        if (state.totalAttempts >= maxTotalAttempts) {
          expect(action.action).not.toBe("retry");
          expect(action.action).not.toBe("escalate");
        }

        // accept IFF pass===true
        if (action.action === "accept") {
          expect(verdict.pass).toBe(true);
        }
        if (verdict.pass === true) {
          expect(action.action).toBe("accept");
        }

        if (action.action === "accept" || action.action === "give_up") {
          done = true;
        } else {
          state = advance(state, action);

          // escalations counter only increases on escalate action
          if (action.action === "escalate") {
            expect(state.escalations).toBeGreaterThan(prevEscalations);
          } else {
            expect(state.escalations).toBe(prevEscalations);
          }
          prevEscalations = state.escalations;
        }
      }

      // Loop terminates within maxTotalAttempts produce cycles
      expect(cycles).toBeLessThanOrEqual(maxTotalAttempts);
    });
  }
});

// ---------------------------------------------------------------------------
// Golden v2.0.0: regenerate ONLY against the unmodified v2.0.0 ladder with
// GOLDEN_WRITE=1 npx vitest run test/unit/ladder.test.ts --maxWorkers=50%
// Otherwise this is a read-only replay, including byte-exact scorecard strings.
// All costs/counters/order are fixed; the ladder does not read the clock.
// ---------------------------------------------------------------------------

describe("golden v2.0.0", () => {
  const fixtureUrl = new URL("./__fixtures__/ladder-v2.0.0-golden.json", import.meta.url);
  const config: RouterConfig = {
    activePreset: "default",
    presets: {},
    rules: [],
    defaultTier: "fast",
  };
  const policies = [
    { name: "default", policy: buildEscalatePolicy(config) },
    {
      name: "two-attempts-per-tier",
      policy: buildEscalatePolicy({
        ...config,
        enforcement: { escalate: { maxAttemptsPerTier: 2 } },
      }),
    },
    {
      name: "floor-medium",
      policy: buildEscalatePolicy({
        ...config,
        enforcement: { escalate: { floorTier: "medium" } },
      }),
    },
  ];
  const verdicts = {
    pass: { pass: true, outcome: "pass", reasons: [] },
    fail: { pass: false, outcome: "fail", reasons: ["check A failed", "check B failed"] },
    unverifiable: { pass: false, outcome: "unverifiable", reasons: ["check unavailable"] },
  } satisfies Record<string, LadderVerdict>;

  function capture(state: LadderState, verdict: LadderVerdict, policy: EscalatePolicy) {
    const action = nextAction(state, verdict, policy);
    const advanced = advance(state, action);
    const accepted = action.action === "accept";
    const method = "golden-v2.0.0";
    return {
      input: { state, verdict, accepted, method },
      output: {
        nextAction: action,
        advance: advanced,
        // The scorecard takes the advanced state and the recorded accepted/method.
        formatLadderScorecard: formatLadderScorecard(advanced, accepted, method),
      },
    };
  }

  function branch(action: LadderAction): string {
    return action.action === "give_up" ? `give_up: ${action.reason}` : action.action;
  }

  function generateGoldenTable(explicitNull = false) {
    return {
      version: "2.0.0",
      policies: policies.map(({ name, policy: originalPolicy }) => {
        const policy = explicitNull ? { ...originalPolicy, effortBump: null } : originalPolicy;
        const matrix: Array<ReturnType<typeof capture> & { id: string }> = [];
        const firstAttemptCost = 2;
        if (policy.costMultiple == null) throw new Error("Golden policies require a cost ceiling");
        const ceiling = firstAttemptCost * policy.costMultiple;
        const costs = [
          { name: "below", value: ceiling - 1 },
          { name: "at", value: ceiling },
          { name: "above", value: ceiling + 1 },
        ];
        // Deliberately include unreachable counter combinations: independently
        // crossing both counters exposes priority at/over every boundary.
        for (const [outcome, verdict] of Object.entries(verdicts)) {
          for (let attemptsThisTier = 0; attemptsThisTier <= policy.maxAttemptsPerTier + 1; attemptsThisTier++) {
            for (let totalAttempts = 0; totalAttempts <= policy.maxTotalAttempts + 1; totalAttempts++) {
              for (const cost of costs) {
                for (const [position, currentTier] of policy.ladder.entries()) {
                  const state: LadderState = {
                    currentTier,
                    attemptsThisTier,
                    totalAttempts,
                    escalations: position,
                    firstAttemptCost,
                    cumulativeCost: cost.value,
                  };
                  matrix.push({
                    id: `${outcome}/${attemptsThisTier}/${totalAttempts}/${cost.name}/${currentTier}`,
                    ...capture(state, verdict, policy),
                  });
                }
              }
            }
          }
        }

        const sequences = policy.ladder.flatMap((producerTier) =>
          (["all-fail", "fail-then-pass", "unverifiable"] as const).map((stream) => {
            const initialState = newLadderState(producerTier, policy);
            let state = initialState;
            const steps: Array<ReturnType<typeof capture>> = [];
            const costPerAttempt = 1;
            for (let attempt = 0; attempt <= policy.maxTotalAttempts; attempt++) {
              state = recordAttempt(state, costPerAttempt);
              const verdict = stream === "unverifiable"
                ? verdicts.unverifiable
                : stream === "fail-then-pass" && attempt > 0
                  ? verdicts.pass
                  : verdicts.fail;
              const step = capture(state, verdict, policy);
              steps.push(step);
              state = step.output.advance;
              const action = step.output.nextAction.action;
              if (action === "accept" || action === "give_up") {
                return {
                  producerTier,
                  stream,
                  costPerAttempt,
                  initialState,
                  steps,
                  finalScorecard: step.output.formatLadderScorecard,
                };
              }
            }
            throw new Error(`Golden sequence did not terminate: ${name}/${producerTier}/${stream}`);
          }),
        );
        // The fixture records the original policy; exercise explicit null only
        // as an input, comparing every resulting state/action/scorecard verbatim.
        return { name, policy: originalPolicy, matrix, sequences };
      }),
    };
  }

  it("replays the complete action/state/scorecard table and terminating sequences", () => {
    const actual = generateGoldenTable();
    for (const { policy, matrix, sequences } of actual.policies) {
      expect(matrix).toHaveLength(
        3 * (policy.maxAttemptsPerTier + 2) * (policy.maxTotalAttempts + 2) * 3 * policy.ladder.length,
      );
      expect(new Set(matrix.map((entry) => entry.id)).size).toBe(matrix.length);
      expect(new Set(matrix.map((entry) => branch(entry.output.nextAction)))).toEqual(new Set([
        "accept",
        "give_up: verification unavailable; no producer escalation",
        `give_up: max total attempts (${policy.maxTotalAttempts}) reached`,
        "give_up: cost ceiling exceeded",
        "retry",
        "escalate",
        "give_up: no higher tier (already at top of ladder)",
      ]));
      expect(sequences).toHaveLength(3 * policy.ladder.length);
    }

    const serialized = `${JSON.stringify(actual, null, 2)}\n`;
    if (process.env.GOLDEN_WRITE === "1") {
      mkdirSync(new URL("./__fixtures__/", import.meta.url), { recursive: true });
      writeFileSync(fixtureUrl, serialized, "utf8");
    }
    const expected = readFileSync(fixtureUrl, "utf8");
    expect(actual).toEqual(JSON.parse(expected));
    expect(serialized).toBe(expected);
  });

  it("replays the same fixture byte-for-byte with effortBump explicitly null", () => {
    const actual = generateGoldenTable(true);
    for (const { matrix, sequences } of actual.policies) {
      for (const entry of [...matrix, ...sequences.flatMap((sequence) => sequence.steps)]) {
        expect(entry.output.nextAction).not.toHaveProperty("effort");
        expect(entry.output.advance).not.toHaveProperty("currentEffort");
      }
      for (const sequence of sequences) expect(sequence.initialState).not.toHaveProperty("currentEffort");
    }
    const expected = readFileSync(fixtureUrl, "utf8");
    expect(actual).toEqual(JSON.parse(expected));
    expect(`${JSON.stringify(actual, null, 2)}\n`).toBe(expected);
  });
});
