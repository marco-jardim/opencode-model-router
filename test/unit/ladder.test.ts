import { describe, it, expect } from "vitest";
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
  type LadderState,
  type LadderVerdict,
} from "../../src/escalate/ladder";
import type { RouterConfig } from "../../src/router/config";

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
