import { describe, it, expect } from "vitest";
import {
  DAY_MS,
  MIN_TINY,
  PRIOR_STRENGTH,
  SAME_RANK_PRIOR,
  capEvidence,
  decayFactor,
  decayTo,
  mergeBeta,
  observe,
  posteriorOf,
  priorForRankOffset,
  sanitizeTuning,
} from "../../src/routing/outcomes/beta";
import { createOutcomeStore } from "../../src/routing/outcomes/store";
import { makeKey } from "../../src/routing/outcomes/types";
import type { BetaState, OutcomeTuning } from "../../src/routing/outcomes/types";

const TUNING: OutcomeTuning = { halfLifeDays: 14, maxEffectiveSamples: 50 };
const HALF_MS = 14 * DAY_MS;
const T0 = Date.UTC(2026, 9, 6, 12, 0, 0);

function mean(s: { alpha: number; beta: number }): number {
  return s.alpha / (s.alpha + s.beta);
}

describe("D7 priors (priorForRankOffset)", () => {
  it.each([
    [-2, 0.3],
    [-1, 0.55],
    [0, 0.8],
    [1, 0.85],
    [2, 0.9],
  ])("rank offset %i has prior mean %f and strength 5", (offset, expected) => {
    const prior = priorForRankOffset(offset);
    expect(Math.abs(mean(prior) - expected)).toBeLessThan(1e-12);
    expect(Math.abs(prior.alpha + prior.beta - PRIOR_STRENGTH)).toBeLessThan(1e-12);
  });

  it("caps at 0.95 from +3 and floors at 0.30 up to -2", () => {
    for (const offset of [3, 4, 9, 1000]) expect(mean(priorForRankOffset(offset))).toBeCloseTo(0.95, 12);
    for (const offset of [-2, -3, -9, -1000]) expect(mean(priorForRankOffset(offset))).toBeCloseTo(0.3, 12);
  });

  it("returns the exact documented pseudo-counts", () => {
    expect(priorForRankOffset(-2)).toEqual({ alpha: 1.5, beta: 3.5 });
    expect(priorForRankOffset(-1)).toEqual({ alpha: 2.75, beta: 2.25 });
    expect(priorForRankOffset(0)).toEqual({ alpha: 4, beta: 1 });
    expect(priorForRankOffset(1)).toEqual({ alpha: 4.25, beta: 0.75 });
    expect(priorForRankOffset(2)).toEqual({ alpha: 4.5, beta: 0.5 });
    expect(priorForRankOffset(3)).toEqual({ alpha: 4.75, beta: 0.25 });
  });

  it("rounds fractional offsets and treats non-finite offsets as same-rank", () => {
    expect(priorForRankOffset(0.4)).toEqual(priorForRankOffset(0));
    expect(priorForRankOffset(0.6)).toEqual(priorForRankOffset(1));
    expect(priorForRankOffset(-1.4)).toEqual(priorForRankOffset(-1));
    expect(priorForRankOffset(Number.NaN)).toEqual(priorForRankOffset(0));
    expect(priorForRankOffset(Number.POSITIVE_INFINITY)).toEqual(priorForRankOffset(0));
  });

  it("SAME_RANK_PRIOR is Beta(4, 1)", () => {
    expect(SAME_RANK_PRIOR).toEqual({ alpha: 4, beta: 1 });
    expect(Object.isFrozen(SAME_RANK_PRIOR)).toBe(true);
  });
});

describe("sanitizeTuning", () => {
  it("clamps and rounds into the documented ranges", () => {
    expect(sanitizeTuning({ halfLifeDays: 0.2, maxEffectiveSamples: 2 })).toEqual({ halfLifeDays: 1, maxEffectiveSamples: 5 });
    expect(sanitizeTuning({ halfLifeDays: 9999, maxEffectiveSamples: 99999 })).toEqual({
      halfLifeDays: 365,
      maxEffectiveSamples: 1000,
    });
    expect(sanitizeTuning({ halfLifeDays: 7.5, maxEffectiveSamples: 49.6 })).toEqual({ halfLifeDays: 7.5, maxEffectiveSamples: 50 });
  });

  it("falls back to 14 days / 50 samples for missing or non-finite values", () => {
    const defaults = { halfLifeDays: 14, maxEffectiveSamples: 50 };
    expect(sanitizeTuning(undefined)).toEqual(defaults);
    expect(sanitizeTuning(null)).toEqual(defaults);
    expect(sanitizeTuning({})).toEqual(defaults);
    expect(sanitizeTuning({ halfLifeDays: Number.NaN, maxEffectiveSamples: Number.POSITIVE_INFINITY })).toEqual(defaults);
  });
});

describe("decay", () => {
  it("decayFactor halves after exactly one half-life", () => {
    expect(decayFactor(HALF_MS, 14)).toBe(0.5);
    expect(decayFactor(2 * HALF_MS, 14)).toBe(0.25);
    expect(decayFactor(0, 14)).toBe(1);
    expect(decayFactor(DAY_MS, 1)).toBe(0.5);
  });

  it("decayFactor treats negative, NaN and non-finite elapsed time as 0 (factor 1)", () => {
    expect(decayFactor(-5 * DAY_MS, 14)).toBe(1);
    expect(decayFactor(Number.NaN, 14)).toBe(1);
    expect(decayFactor(Number.NEGATIVE_INFINITY, 14)).toBe(1);
    expect(decayFactor(Number.POSITIVE_INFINITY, 14)).toBe(1);
  });

  it("decayTo and posteriorOf: {10, 6} becomes {5, 3} after one half-life, exactly", () => {
    const state: BetaState = { alpha: 10, beta: 6, updatedAt: T0 };
    expect(decayTo(state, T0 + HALF_MS, TUNING)).toEqual({ alpha: 5, beta: 3, updatedAt: T0 + HALF_MS });
    const p = posteriorOf(state, { alpha: 4, beta: 1 }, T0 + HALF_MS, { ...TUNING, maxEffectiveSamples: 1000 });
    expect(p.alpha).toBe(9);
    expect(p.beta).toBe(4);
    expect(p.n).toBe(8);
    expect(p.mean).toBe(9 / 13);
  });

  it("is multiplicative: materialising at t1 then t2 equals materialising at t2 (no drift)", () => {
    const state: BetaState = { alpha: 7.3, beta: 2.1, updatedAt: T0 };
    const t1 = T0 + 3.7 * DAY_MS;
    const t2 = T0 + 9.1 * DAY_MS;
    const stepwise = decayTo(decayTo(state, t1, TUNING), t2, TUNING);
    const direct = decayTo(state, t2, TUNING);
    expect(Math.abs(stepwise.alpha - direct.alpha)).toBeLessThan(1e-12);
    expect(Math.abs(stepwise.beta - direct.beta)).toBeLessThan(1e-12);
    expect(stepwise.updatedAt).toBe(direct.updatedAt);
  });

  it("write at t1 then t2 equals one write at t2 (within 1e-12)", () => {
    const t1 = T0 + 2 * DAY_MS;
    const t2 = T0 + 5 * DAY_MS;
    let twice = observe(undefined, true, T0, TUNING);
    twice = observe(twice, false, t1, TUNING);
    twice = observe(twice, true, t2, TUNING);
    // The same history expressed at t2 directly.
    const first = decayTo({ alpha: 1, beta: 0, updatedAt: T0 }, t2, TUNING);
    const second = decayTo({ alpha: 0, beta: 1, updatedAt: t1 }, t2, TUNING);
    expect(Math.abs(twice.alpha - (first.alpha + second.alpha + 1))).toBeLessThan(1e-12);
    expect(Math.abs(twice.beta - (first.beta + second.beta))).toBeLessThan(1e-12);
  });

  it("flushes tiny totals to exactly 0 so subnormals never reach storage", () => {
    const tiny = decayTo({ alpha: 1e-13, beta: 0, updatedAt: T0 }, T0, TUNING);
    expect(tiny.alpha).toBe(0);
    expect(tiny.beta).toBe(0);
    const old = decayTo({ alpha: 1, beta: 1, updatedAt: T0 }, T0 + 50 * HALF_MS, TUNING);
    expect(old.alpha + old.beta).toBe(0);
    expect(MIN_TINY).toBe(1e-12);
  });

  it("does not mutate its input", () => {
    const state = Object.freeze({ alpha: 3, beta: 2, updatedAt: T0 });
    const out = decayTo(state, T0 + HALF_MS, TUNING);
    expect(out).not.toBe(state);
    expect(state).toEqual({ alpha: 3, beta: 2, updatedAt: T0 });
  });
});

describe("observe (D4)", () => {
  it("a pass adds one success, a fail one failure", () => {
    expect(observe(undefined, true, T0, TUNING)).toEqual({ alpha: 1, beta: 0, updatedAt: T0 });
    expect(observe(undefined, false, T0, TUNING)).toEqual({ alpha: 0, beta: 1, updatedAt: T0 });
    const s = observe(observe(undefined, true, T0, TUNING), false, T0, TUNING);
    expect(s).toEqual({ alpha: 1, beta: 1, updatedAt: T0 });
  });

  it("decays the stored evidence before adding the observation", () => {
    const s = observe({ alpha: 4, beta: 0, updatedAt: T0 }, true, T0 + HALF_MS, TUNING);
    expect(s).toEqual({ alpha: 3, beta: 0, updatedAt: T0 + HALF_MS });
  });

  it("a refusal modelled as a failure moves the posterior mean down", () => {
    const before = posteriorOf(undefined, SAME_RANK_PRIOR, T0, TUNING);
    const after = posteriorOf(observe(undefined, false, T0, TUNING), SAME_RANK_PRIOR, T0, TUNING);
    expect(after.mean).toBeLessThan(before.mean);
    expect(after.beta).toBe(2);
    expect(after.alpha).toBe(4);
  });

  it("a NaN clock never decays and never produces NaN", () => {
    const s = observe({ alpha: 2, beta: 1, updatedAt: T0 }, true, Number.NaN, TUNING);
    expect(s).toEqual({ alpha: 3, beta: 1, updatedAt: T0 });
    const fresh = observe(undefined, false, Number.NaN, TUNING);
    expect(Number.isFinite(fresh.alpha + fresh.beta + fresh.updatedAt)).toBe(true);
    expect(fresh.beta).toBe(1);
  });
});

describe("effective-sample cap", () => {
  it("capEvidence scales both sides and keeps the evidence mean (1e-9)", () => {
    const capped = capEvidence({ alpha: 300, beta: 100, updatedAt: T0 }, 50);
    expect(capped.alpha + capped.beta).toBeCloseTo(50, 12);
    expect(Math.abs(mean(capped) - 0.75)).toBeLessThan(1e-9);
    expect(capped.updatedAt).toBe(T0);
  });

  it("capEvidence leaves a state under the cap untouched", () => {
    const state: BetaState = { alpha: 20, beta: 30, updatedAt: T0 };
    expect(capEvidence(state, 50)).toBe(state);
  });

  it("400 records at M = 50 never exceed the cap, and the mean tracks the recent rate within 1e-9 of the exact recurrence", () => {
    const tuning = { halfLifeDays: 14, maxEffectiveSamples: 50 };
    let state: BetaState | undefined;
    // Reference recurrence on (alpha, beta) with the same rule, written independently.
    let a = 0;
    let b = 0;
    for (let i = 0; i < 400; i++) {
      const success = i % 4 !== 0; // 75 % successes
      state = observe(state, success, T0, tuning);
      if (success) a += 1;
      else b += 1;
      const n = a + b;
      if (n > 50) {
        a *= 50 / n;
        b *= 50 / n;
      }
      expect(state.alpha + state.beta).toBeLessThanOrEqual(50 + 1e-9);
      expect(Math.abs(state.alpha - a)).toBeLessThan(1e-9);
      expect(Math.abs(state.beta - b)).toBeLessThan(1e-9);
    }
    expect(state).toBeDefined();
    if (state) expect(Math.abs(mean(state) - 0.75)).toBeLessThan(0.05);
  });

  it("posteriorOf caps stored evidence when the tuning was lowered after the write", () => {
    const state: BetaState = { alpha: 40, beta: 10, updatedAt: T0 };
    const p = posteriorOf(state, SAME_RANK_PRIOR, T0, { halfLifeDays: 14, maxEffectiveSamples: 10 });
    expect(p.n).toBeCloseTo(10, 12);
    expect(p.alpha).toBeCloseTo(4 + 8, 12);
    expect(p.beta).toBeCloseTo(1 + 2, 12);
    expect(state).toEqual({ alpha: 40, beta: 10, updatedAt: T0 });
  });
});

describe("posteriorOf (read-only)", () => {
  it("no evidence returns exactly the prior", () => {
    const prior = { alpha: 2.75, beta: 2.25 };
    const p = posteriorOf(undefined, prior, T0, TUNING);
    expect(p.alpha).toBe(2.75);
    expect(p.beta).toBe(2.25);
    expect(p.mean).toBe(2.75 / 5);
    expect(p.n).toBe(0);
    expect(p.prior).toEqual(prior);
  });

  it.each([
    [{ alpha: Number.NaN, beta: 1 }],
    [{ alpha: 4, beta: 0 }],
    [{ alpha: -1, beta: 2 }],
    [{ alpha: Number.POSITIVE_INFINITY, beta: 1 }],
  ])("an invalid prior %j falls back to the same-rank prior", (prior) => {
    const p = posteriorOf(undefined, prior, T0, TUNING);
    expect(p.prior).toEqual(SAME_RANK_PRIOR);
    expect(p.mean).toBe(0.8);
  });

  it("evidence decays toward the prior, not toward Beta(0, 0)", () => {
    const state: BetaState = { alpha: 0, beta: 20, updatedAt: T0 };
    const fresh = posteriorOf(state, SAME_RANK_PRIOR, T0, TUNING);
    const aged = posteriorOf(state, SAME_RANK_PRIOR, T0 + 10 * HALF_MS, TUNING);
    expect(fresh.mean).toBeCloseTo(4 / 25, 12);
    expect(Math.abs(aged.mean - 0.8)).toBeLessThan(0.01);
    expect(aged.n).toBeLessThan(0.05);
  });

  it("a clock going backwards does not inflate: reading at t − 1 day equals reading at t", () => {
    const state: BetaState = { alpha: 12, beta: 4, updatedAt: T0 };
    const atT = posteriorOf(state, SAME_RANK_PRIOR, T0, TUNING);
    const back = posteriorOf(state, SAME_RANK_PRIOR, T0 - DAY_MS, TUNING);
    expect(back).toEqual(atT);
    expect(decayTo(state, T0 - DAY_MS, TUNING)).toEqual(state);
    expect(decayTo(state, T0 - 1e15, TUNING).updatedAt).toBe(T0);
  });

  it("after a backwards read a later forward read is exactly half after one half-life", () => {
    const state: BetaState = { alpha: 12, beta: 4, updatedAt: T0 };
    posteriorOf(state, SAME_RANK_PRIOR, T0 - DAY_MS, TUNING);
    const later = posteriorOf(state, SAME_RANK_PRIOR, T0 + HALF_MS, { halfLifeDays: 14, maxEffectiveSamples: 1000 });
    expect(later.alpha - SAME_RANK_PRIOR.alpha).toBe(6);
    expect(later.beta - SAME_RANK_PRIOR.beta).toBe(2);
  });

  it("a NaN clock means no decay", () => {
    const state: BetaState = { alpha: 12, beta: 4, updatedAt: T0 };
    expect(posteriorOf(state, SAME_RANK_PRIOR, Number.NaN, TUNING)).toEqual(posteriorOf(state, SAME_RANK_PRIOR, T0, TUNING));
  });

  it("dt = 1e15 ms underflows to evidence 0 and the posterior is the prior", () => {
    const state: BetaState = { alpha: 30, beta: 20, updatedAt: T0 };
    const p = posteriorOf(state, { alpha: 4.5, beta: 0.5 }, T0 + 1e15, TUNING);
    expect(p.alpha).toBe(4.5);
    expect(p.beta).toBe(0.5);
    expect(p.n).toBe(0);
  });

  it("is pure: frozen inputs, identical output on repeated reads", () => {
    const state = Object.freeze({ alpha: 5, beta: 5, updatedAt: T0 });
    const prior = Object.freeze({ alpha: 4, beta: 1 });
    const first = posteriorOf(state, prior, T0 + DAY_MS, TUNING);
    const second = posteriorOf(state, prior, T0 + DAY_MS, TUNING);
    expect(second).toEqual(first);
    expect(state).toEqual({ alpha: 5, beta: 5, updatedAt: T0 });
  });
});

describe("numeric stability", () => {
  it("1e6 observations keep evidence ≤ M + 1 and the mean finite", () => {
    const tuning = { halfLifeDays: 14, maxEffectiveSamples: 1000 };
    let state: BetaState | undefined;
    let maxN = 0;
    for (let i = 0; i < 1_000_000; i++) {
      state = observe(state, i % 3 !== 0, T0 + i * 1000, tuning);
      const n = state.alpha + state.beta;
      if (n > maxN) maxN = n;
    }
    expect(maxN).toBeLessThanOrEqual(1001);
    expect(state).toBeDefined();
    if (state) {
      const p = posteriorOf(state, SAME_RANK_PRIOR, T0 + 1_000_000 * 1000, tuning);
      expect(Number.isFinite(p.mean)).toBe(true);
      expect(p.mean).toBeGreaterThan(0);
      expect(p.mean).toBeLessThan(1);
    }
  });

  it("the posterior is always proper (alpha, beta > 0) even with zero evidence", () => {
    for (const offset of [-5, -1, 0, 1, 5]) {
      const p = posteriorOf({ alpha: 0, beta: 0, updatedAt: T0 }, priorForRankOffset(offset), T0, TUNING);
      expect(p.alpha).toBeGreaterThan(0);
      expect(p.beta).toBeGreaterThan(0);
      expect(p.alpha + p.beta).toBeGreaterThanOrEqual(5);
    }
  });
});

describe("mergeBeta", () => {
  it("sums evidence decayed to now and keeps the newest instant", () => {
    const a: BetaState = { alpha: 10, beta: 2, updatedAt: T0 };
    const b: BetaState = { alpha: 4, beta: 6, updatedAt: T0 + HALF_MS };
    const merged = mergeBeta(a, b, T0 + HALF_MS, { halfLifeDays: 14, maxEffectiveSamples: 1000 });
    expect(merged).toEqual({ alpha: 5 + 4, beta: 1 + 6, updatedAt: T0 + HALF_MS });
  });

  it("caps the sum", () => {
    const a: BetaState = { alpha: 40, beta: 0, updatedAt: T0 };
    const b: BetaState = { alpha: 0, beta: 40, updatedAt: T0 };
    const merged = mergeBeta(a, b, T0, TUNING);
    expect(merged.alpha + merged.beta).toBeCloseTo(50, 12);
    expect(merged.alpha).toBeCloseTo(25, 12);
  });

  it("a clock before either state never inflates and keeps updatedAt at the newest state", () => {
    const a: BetaState = { alpha: 6, beta: 2, updatedAt: T0 };
    const b: BetaState = { alpha: 2, beta: 6, updatedAt: T0 - DAY_MS };
    const merged = mergeBeta(a, b, T0 - 10 * DAY_MS, TUNING);
    expect(merged.updatedAt).toBe(T0);
    expect(merged.alpha + merged.beta).toBeLessThanOrEqual(16);
    expect(merged.alpha).toBeGreaterThanOrEqual(6);
  });

  it("a NaN clock merges at the newest stored instant", () => {
    const a: BetaState = { alpha: 3, beta: 1, updatedAt: T0 };
    const b: BetaState = { alpha: 1, beta: 3, updatedAt: T0 };
    expect(mergeBeta(a, b, Number.NaN, TUNING)).toEqual({ alpha: 4, beta: 4, updatedAt: T0 });
  });
});

// ---------------------------------------------------------------------------
// Through the store (added with store.ts): D4 observations, no-op rules, read purity, drift.
// ---------------------------------------------------------------------------

describe("beta evidence through the outcome store", () => {
  const KEY = makeKey("implement", { origin: "router", id: "medium" }, "anthropic", "claude-sonnet-5-5");
  const sig = (attemptID: string) => ({ attemptID, step: "dispatch" as const });

  function fakeClock(start = T0) {
    let t = start;
    return { now: () => t, set: (v: number) => void (t = v) };
  }

  it("pass, fail and refusal move the posterior in the expected directions", () => {
    const store = createOutcomeStore({ now: fakeClock().now });
    const prior = store.posterior(KEY).mean;
    store.recordVerdict(KEY, "pass", sig("a"));
    const afterPass = store.posterior(KEY).mean;
    store.recordVerdict(KEY, "fail", sig("b"));
    const afterFail = store.posterior(KEY).mean;
    store.recordFalseRefusal(KEY, sig("c"));
    const afterRefusal = store.posterior(KEY).mean;
    expect(afterPass).toBeGreaterThan(prior);
    expect(afterFail).toBeLessThan(afterPass);
    expect(afterRefusal).toBeLessThan(afterFail);
    expect(store.posterior(KEY).n).toBe(3);
  });

  it("unverifiable is a no-op: returns false, revision unchanged, snapshot deep-equal", () => {
    const store = createOutcomeStore({ now: fakeClock().now });
    store.recordVerdict(KEY, "pass", sig("a"));
    const before = store.snapshot();
    const revision = store.revision;
    expect(store.recordVerdict(KEY, "unverifiable", sig("b"))).toBe(false);
    expect(store.revision).toBe(revision);
    expect(store.snapshot()).toEqual(before);
  });

  it("reads never change the revision or the snapshot (no decay drift)", () => {
    const c = fakeClock();
    const store = createOutcomeStore({ now: c.now });
    store.recordVerdict(KEY, "pass", sig("a"));
    const revision = store.revision;
    const snapshot = JSON.stringify(store.snapshot());
    for (const days of [1, 7, 14, 28, 365]) {
      c.set(T0 + days * DAY_MS);
      store.posterior(KEY);
    }
    expect(store.revision).toBe(revision);
    expect(JSON.stringify(store.snapshot())).toBe(snapshot);
  });

  it("writes at t1 then t2 equal one write at t2 within 1e-12", () => {
    const c = fakeClock();
    const store = createOutcomeStore({ now: c.now });
    store.recordVerdict(KEY, "pass", sig("a"));
    c.set(T0 + 2 * DAY_MS);
    store.recordVerdict(KEY, "fail", sig("b"));
    c.set(T0 + 5 * DAY_MS);
    store.recordVerdict(KEY, "pass", sig("c"));
    const beta = store.snapshot().entries[KEY]?.beta;
    const f5 = 2 ** (-5 / 14);
    const f3 = 2 ** (-3 / 14);
    expect(Math.abs((beta?.alpha ?? Number.NaN) - (f5 + 1))).toBeLessThan(1e-12);
    expect(Math.abs((beta?.beta ?? Number.NaN) - f3)).toBeLessThan(1e-12);
    expect(beta?.updatedAt).toBe(T0 + 5 * DAY_MS);
  });

  it("400 verdicts at M = 50 keep evidence ≤ 50 and the mean within 1e-9 of the exact recurrence", () => {
    const store = createOutcomeStore({ now: fakeClock().now, maxEffectiveSamples: 50 });
    let a = 0;
    let b = 0;
    for (let i = 0; i < 400; i++) {
      const pass = i % 5 !== 0;
      store.recordVerdict(KEY, pass ? "pass" : "fail", sig(`v${i}`));
      if (pass) a += 1;
      else b += 1;
      if (a + b > 50) {
        const s = 50 / (a + b);
        a *= s;
        b *= s;
      }
    }
    const p = store.posterior(KEY);
    expect(p.n).toBeLessThanOrEqual(50 + 1e-9);
    expect(Math.abs(p.mean - (4 + a) / (5 + a + b))).toBeLessThan(1e-9);
  });

  it("a NaN clock never decays and never poisons the stored evidence", () => {
    const c = fakeClock();
    const store = createOutcomeStore({ now: c.now });
    store.recordVerdict(KEY, "pass", sig("a"));
    c.set(Number.NaN);
    store.recordVerdict(KEY, "pass", sig("b"));
    const p = store.posterior(KEY);
    expect(Number.isFinite(p.mean)).toBe(true);
    expect(p.n).toBe(2);
    expect(Number.isFinite(store.snapshot().entries[KEY]?.beta.updatedAt ?? Number.NaN)).toBe(true);
  });
});
