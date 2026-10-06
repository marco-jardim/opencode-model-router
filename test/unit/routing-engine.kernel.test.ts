import { describe, it, expect } from "vitest";
import {
  DEFAULT_REMAINING_TURNS,
  GIVE_UP_COST,
  MIN_EVIDENCE_TO_SWITCH_DOWN,
  candidateKey,
  coversNeeds,
  decide,
  giveUpCost,
  hasMinEvidence,
} from "../../src/routing/engine/kernel";
import type {
  Candidate,
  ChosenDispatch,
  DecisionInput,
  EngineStoreView,
  KernelRouting,
  Ladder,
} from "../../src/routing/engine/types";
import type { Need, TaskFacts } from "../../src/routing/classify/types";
import { createOutcomeStore } from "../../src/routing/outcomes/store";
import { emptyCostStats } from "../../src/routing/outcomes/cost";
import { makeKey } from "../../src/routing/outcomes/types";
import type {
  BetaPrior,
  CostStats,
  ModelPricing,
  OutcomeKey,
  Posterior,
  TokenMeans,
} from "../../src/routing/outcomes/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ALL_NEEDS: readonly Need[] = ["shell", "web", "edit", "network", "external_dir"];
const READ_ONLY: readonly Need[] = ["web"];
const PRICED: ModelPricing = [{ input: 3, output: 15, cache: { read: 0.3, write: 3.75 } }];
const UNPRICED: ModelPricing = [];

function rung(
  id: string,
  model: string,
  variant: string | null,
  costRatio: number,
  rank: number,
  extra: Partial<Candidate> = {},
): Candidate {
  return {
    agent: { origin: "router", id },
    model,
    variant,
    costRatio,
    rank,
    tier: id,
    source: "tier",
    grants: ALL_NEEDS,
    ...extra,
  };
}

const FAST = rung("fast", "anthropic/claude-sonnet-5-5", "low", 1, 0);
const MEDIUM = rung("medium", "anthropic/claude-sonnet-5-5", "medium", 5, 1);
const HEAVY = rung("heavy", "anthropic/claude-opus-5-5", "xhigh", 20, 2);

/** fast → medium → heavy → give up (the shipped anthropic ladder). */
function routerLadder(cands: readonly Candidate[] = [FAST, MEDIUM, HEAVY], classRank: number | null = 1): Ladder {
  return {
    candidates: cands,
    next: cands.map((_, k) => (k + 1 < cands.length ? k + 1 : null)),
    classRank,
    excluded: [],
  };
}

function facts(over: Partial<TaskFacts> = {}): TaskFacts {
  return {
    class: "implement",
    risk: "high",
    scope: "single",
    needs: [],
    confidence: 0.9,
    source: "route-line",
    ...over,
  };
}

/** `safe` + `high` → U = 100; detection values chosen so d = 1 (deterministic) and d = 0.5 (grader). */
const ROUTING: KernelRouting = {
  profile: "safe",
  margin: 0.2,
  minClassConfidence: 0.7,
  detection: { deterministic: 1, grader: 0.5, none: 0.3 },
};

function chosenOf(c: Candidate): ChosenDispatch {
  return { agent: c.agent, model: c.model, variant: c.variant };
}

function keyOf(c: Candidate, cls = "implement"): OutcomeKey {
  return candidateKey(cls, c);
}

interface FakeStoreSpec {
  /** Posterior mean per key; absent → the prior's mean. */
  readonly p?: Readonly<Record<string, number>>;
  /** Effective evidence per key; absent → 0. */
  readonly n?: Readonly<Record<string, number>>;
  readonly cost?: Readonly<Record<string, CostStats>>;
  readonly profile?: TokenMeans | null;
}

interface FakeStore extends EngineStoreView {
  readonly calls: { posterior: number; cost: number; profile: number };
  readonly priors: Map<string, BetaPrior>;
}

function fakeStore(spec: FakeStoreSpec = {}): FakeStore {
  const calls = { posterior: 0, cost: 0, profile: 0 };
  const priors = new Map<string, BetaPrior>();
  return {
    calls,
    priors,
    posterior(key: OutcomeKey, prior?: BetaPrior): Posterior {
      calls.posterior += 1;
      const pr = prior ?? { alpha: 4, beta: 1 };
      priors.set(key, pr);
      const mean = spec.p?.[key] ?? pr.alpha / (pr.alpha + pr.beta);
      return { alpha: pr.alpha, beta: pr.beta, mean, n: spec.n?.[key] ?? 0, prior: pr };
    },
    cost(key: OutcomeKey): CostStats {
      calls.cost += 1;
      return spec.cost?.[key] ?? emptyCostStats();
    },
    classTokenProfile(): TokenMeans | null {
      calls.profile += 1;
      return spec.profile ?? null;
    },
  };
}

/** p = (0.6, 0.9, 0.95) for (fast, medium, heavy) — the worked example of the design discussion. */
function workedStore(): FakeStore {
  // 10 recorded outcomes per key: enough evidence for a down switch (A24).
  const n = { [keyOf(FAST)]: 10, [keyOf(MEDIUM)]: 10, [keyOf(HEAVY)]: 10 };
  return fakeStore({ p: { [keyOf(FAST)]: 0.6, [keyOf(MEDIUM)]: 0.9, [keyOf(HEAVY)]: 0.95 }, n });
}

function input(over: Partial<DecisionInput> = {}): DecisionInput {
  return {
    facts: facts(),
    chosen: chosenOf(HEAVY),
    ladder: routerLadder(),
    detection: "deterministic",
    pin: false,
    routing: ROUTING,
    store: workedStore(),
    ...over,
  };
}

function measured(meanUSD: number, extra: Partial<CostStats> = {}): CostStats {
  return { ...emptyCostStats(), measuredUSD: { mean: meanUSD, n: 3 }, ...extra };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("kernel constants", () => {
  it("D8 give-up table per profile and risk", () => {
    expect(GIVE_UP_COST).toEqual({
      frugal: { low: 3, medium: 8, high: 20 },
      balanced: { low: 5, medium: 15, high: 40 },
      safe: { low: 10, medium: 30, high: 100 },
    });
    expect(giveUpCost("safe", "high")).toBe(100);
    expect(giveUpCost("balanced", "low")).toBe(5);
    expect(giveUpCost("nope" as never, "high")).toBe(40);
    expect(giveUpCost("frugal", "nope" as never)).toBe(8);
    expect(DEFAULT_REMAINING_TURNS).toBe(4);
  });

  it("candidate keys use the 1.3 outcome key format", () => {
    expect(keyOf(MEDIUM)).toBe(makeKey("implement", { origin: "router", id: "medium" }, "anthropic", "claude-sonnet-5-5", "medium"));
    const host: Candidate = rung("explore", "anthropic/claude-haiku-4-5", null, 1, 0, { agent: { origin: "host", id: "explore" } });
    expect(candidateKey("search", host)).toBe("search|host:explore|anthropic/claude-haiku-4-5#default");
    // A `#variant` in the model ref is split off when the variant field is empty.
    expect(candidateKey("search", { agent: host.agent, model: "anthropic/claude-haiku-4-5#high", variant: null })).toBe(
      "search|host:explore|anthropic/claude-haiku-4-5#high",
    );
    // A ref without a provider is stored under `unknown`, never thrown on.
    expect(candidateKey("search", { agent: host.agent, model: "bare", variant: null })).toBe("search|host:explore|unknown/bare#default");
  });

  it("A11 coverage: unknown permissions cover no need; no need is always covered", () => {
    expect(coversNeeds(null, [])).toBe(true);
    expect(coversNeeds(null, ["edit"])).toBe(false);
    expect(coversNeeds(READ_ONLY, ["web"])).toBe(true);
    expect(coversNeeds(READ_ONLY, ["web", "shell"])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D8 worked examples
// ---------------------------------------------------------------------------

describe("D8 worked examples: p = (0.6, 0.9, 0.95), U = 100", () => {
  it("d = 1 → fast", () => {
    const d = decide(input({ detection: "deterministic" }));
    // C(heavy) = 20 + 0.05·100 = 25; C(medium) = 5 + 0.1·25 = 7.5; C(fast) = 1 + 0.4·7.5 = 4.
    expect(d.unit).toBe("ratio");
    expect(d.costs[keyOf(HEAVY)]).toBeCloseTo(25, 10);
    expect(d.costs[keyOf(MEDIUM)]).toBeCloseTo(7.5, 10);
    expect(d.costs[keyOf(FAST)]).toBeCloseTo(4, 10);
    expect(d.best?.key).toBe(keyOf(FAST));
    expect(d.best).toEqual({
      key: keyOf(FAST),
      agent: "fast",
      origin: "router",
      model: "anthropic/claude-sonnet-5-5",
      variant: "low",
    });
    expect(d.target).toBe(FAST);
    expect(d.switched).toBe(true);
    expect(d.reasonCode).toBe("switched");
    expect(d.reason).toContain("C(best)=4");
  });

  it("d = 0.5 → medium", () => {
    const d = decide(input({ detection: "grader", chosen: chosenOf(FAST) }));
    // C(heavy) = 20 + 0.05·100 = 25
    // C(medium) = 5 + 0.1·(0.5·25 + 0.5·100) = 11.25
    // C(fast) = 1 + 0.4·(0.5·11.25 + 0.5·100) = 23.25
    expect(d.costs[keyOf(HEAVY)]).toBeCloseTo(25, 10);
    expect(d.costs[keyOf(MEDIUM)]).toBeCloseTo(11.25, 10);
    expect(d.costs[keyOf(FAST)]).toBeCloseTo(23.25, 10);
    expect(d.best?.key).toBe(keyOf(MEDIUM));
    expect(d.switched).toBe(true); // 11.25 < 0.8 · 23.25
    expect(d.chosen.key).toBe(keyOf(FAST));
  });

  it("terminal give-up: a lone rung costs c + (1 − p)·U whatever d is", () => {
    const ladder = routerLadder([FAST]);
    for (const detection of ["deterministic", "grader", "none"] as const) {
      const d = decide(input({ ladder, chosen: chosenOf(FAST), detection }));
      expect(d.costs[keyOf(FAST)]).toBeCloseTo(1 + 0.4 * 100, 10);
    }
  });

  it("an out-of-range, self or cyclic successor is a give-up, never an infinite escalation", () => {
    const self: Ladder = { ...routerLadder([FAST]), next: [0] };
    expect(decide(input({ ladder: self, chosen: chosenOf(FAST) })).costs[keyOf(FAST)]).toBeCloseTo(41, 10);
    const outOfRange: Ladder = { ...routerLadder([FAST]), next: [7] };
    expect(decide(input({ ladder: outOfRange, chosen: chosenOf(FAST) })).costs[keyOf(FAST)]).toBeCloseTo(41, 10);
    const fractional: Ladder = { ...routerLadder([FAST, MEDIUM]), next: [0.5, null] };
    expect(decide(input({ ladder: fractional, chosen: chosenOf(FAST) })).costs[keyOf(FAST)]).toBeCloseTo(41, 10);
    const cycle: Ladder = { ...routerLadder([FAST, MEDIUM]), next: [1, 0] };
    const d = decide(input({ ladder: cycle, chosen: chosenOf(FAST) }));
    // fast → medium → (back edge = give up): C(medium) = 5 + 0.1·100 = 15; C(fast) = 1 + 0.4·15 = 7.
    expect(d.costs[keyOf(MEDIUM)]).toBeCloseTo(15, 10);
    expect(d.costs[keyOf(FAST)]).toBeCloseTo(7, 10);
    const shortNext: Ladder = { ...routerLadder([FAST, MEDIUM]), next: [1] };
    expect(decide(input({ ladder: shortNext, chosen: chosenOf(FAST) })).costs[keyOf(MEDIUM)]).toBeCloseTo(15, 10);
  });

  it("D7 priors without a store: rank offsets against the class's static tier", () => {
    // implement → static medium (classRank 1): fast −1 → 0.55, medium 0 → 0.80, heavy +1 → 0.85.
    // balanced/medium U = 15, grader d = 0.7.
    const routing: KernelRouting = { ...ROUTING, profile: "balanced", detection: { deterministic: 0.95, grader: 0.7, none: 0.3 } };
    const d = decide(input({ store: null, routing, facts: facts({ risk: "medium" }), detection: "grader", chosen: chosenOf(MEDIUM) }));
    expect(d.costs[keyOf(HEAVY)]).toBeCloseTo(20 + 0.15 * 15, 10);
    expect(d.costs[keyOf(MEDIUM)]).toBeCloseTo(9.015, 10);
    expect(d.costs[keyOf(FAST)]).toBeCloseTo(5.864725, 10);
    expect(d.best?.key).toBe(keyOf(FAST));
    expect(d.unit).toBe("ratio");
    expect(d.confidence).toBe(0); // priors only
  });

  it("passes the D7 prior of each candidate's rank offset to the store", () => {
    const store = fakeStore();
    decide(input({ store }));
    expect(store.priors.get(keyOf(FAST))).toEqual({ alpha: 2.75, beta: 2.25 });
    expect(store.priors.get(keyOf(MEDIUM))).toEqual({ alpha: 4, beta: 1 });
    expect(store.priors.get(keyOf(HEAVY))).toEqual({ alpha: 4.25, beta: 0.75 });
    // Without a static tier the priors are centred on the chosen rung (heavy).
    const centred = fakeStore();
    decide(input({ store: centred, ladder: routerLadder(undefined, null) }));
    expect(centred.priors.get(keyOf(HEAVY))).toEqual({ alpha: 4, beta: 1 });
    expect(centred.priors.get(keyOf(FAST))).toEqual({ alpha: 1.5, beta: 3.5 });
  });

  it("reads real posteriors from the 1.3 store", () => {
    const store = createOutcomeStore({ now: () => 1_000 });
    const key = keyOf(FAST, "search");
    for (let i = 0; i < 10; i++) store.recordVerdict(key, "pass", { attemptID: `a${i}`, step: "dispatch" });
    const routing: KernelRouting = { ...ROUTING, profile: "balanced" };
    const d = decide(input({
      store,
      routing,
      facts: facts({ class: "search", risk: "low" }),
      ladder: routerLadder([FAST], 0),
      chosen: chosenOf(FAST),
    }));
    // Beta(4, 1) + 10 passes → mean 14/15; C = 1 + (1/15)·5.
    expect(d.costs[key]).toBeCloseTo(1 + 5 / 15, 10);
    expect(d.confidence).toBe(Math.round(0.9 * (10 / 15) * 100) / 100);
  });
});

// ---------------------------------------------------------------------------
// D9 margin rule (A16), pin, never-down, gates
// ---------------------------------------------------------------------------

/** Two independent single-rung chains with p = 1, so C(k) = c_k exactly. */
function pairLadder(cheap: number, dear: number): { ladder: Ladder; a: Candidate; b: Candidate; store: FakeStore } {
  const a = rung("fast", "openai/gpt-6-luna-fast", "medium", cheap, 1);
  const b = rung("medium", "anthropic/claude-sonnet-5-5", "xhigh", dear, 1);
  return {
    a,
    b,
    ladder: { candidates: [a, b], next: [null, null], classRank: 1, excluded: [] },
    store: fakeStore({ p: { [keyOf(a)]: 1, [keyOf(b)]: 1 }, n: { [keyOf(a)]: 10, [keyOf(b)]: 10 } }),
  };
}

describe("D9 margin rule (A16)", () => {
  it("exactly at the boundary the choice is kept (strict <)", () => {
    const { ladder, b, store } = pairLadder(4, 8);
    const d = decide(input({ ladder, store, chosen: chosenOf(b), routing: { ...ROUTING, margin: 0.5 } }));
    expect(d.costs).toEqual({ [keyOf(ladder.candidates[0]!)]: 4, [keyOf(b)]: 8 });
    expect(d.best?.key).toBe(keyOf(ladder.candidates[0]!));
    expect(d.switched).toBe(false);
    expect(d.reasonCode).toBe("kept:margin");
    expect(d.reason).toContain("is not <");
  });

  it("strictly inside the margin it switches", () => {
    const { ladder, b, store } = pairLadder(4, 8);
    const d = decide(input({ ladder, store, chosen: chosenOf(b), routing: { ...ROUTING, margin: 0.25 } }));
    expect(d.switched).toBe(true);
    expect(d.reasonCode).toBe("switched");
  });

  it("best == chosen is never a switch, even with margin 0", () => {
    const { ladder, a, store } = pairLadder(4, 8);
    const d = decide(input({ ladder, store, chosen: chosenOf(a), routing: { ...ROUTING, margin: 0 } }));
    expect(d.best?.key).toBe(keyOf(a));
    expect(d.switched).toBe(false);
    expect(d.reasonCode).toBe("kept:best-is-chosen");
  });

  it("a tie keeps the chosen dispatch as best", () => {
    const { ladder, b, store } = pairLadder(8, 8);
    const d = decide(input({ ladder, store, chosen: chosenOf(b), routing: { ...ROUTING, margin: 0 } }));
    expect(d.best?.key).toBe(keyOf(b));
    expect(d.reasonCode).toBe("kept:best-is-chosen");
  });

  it("an unusable margin or minClassConfidence never switches", () => {
    const { ladder, b, store } = pairLadder(1, 8);
    for (const routing of [
      { ...ROUTING, margin: Number.NaN },
      { ...ROUTING, margin: 1 },
      { ...ROUTING, margin: -0.1 },
    ]) {
      const d = decide(input({ ladder, store, chosen: chosenOf(b), routing }));
      expect(d.switched).toBe(false);
      expect(d.reasonCode).toBe("kept:invalid-config");
    }
    const noMin = decide(input({ ladder, store, chosen: chosenOf(b), routing: { ...ROUTING, minClassConfidence: Number.NaN } }));
    expect(noMin.switched).toBe(false);
    expect(noMin.reasonCode).toBe("kept:invalid-config");
  });
});

describe("A24 evidence gate: a down switch needs ≥ 5 recorded outcomes on best's key (QA-1.4-6)", () => {
  const BALANCED: KernelRouting = { profile: "balanced", margin: 0.2, minClassConfidence: 0.7, detection: { deterministic: 0.95, grader: 0.7, none: 0.3 } };
  const mediumFacts = (): TaskFacts => facts({ risk: "medium" });

  function priorsOnly(store: DecisionInput["store"]) {
    return decide(input({ store, routing: BALANCED, facts: mediumFacts(), detection: "deterministic", chosen: chosenOf(MEDIUM) }));
  }

  it("implement + deterministic with an empty store: the priors would switch, the gate keeps (kept:evidence)", () => {
    const d = priorsOnly(createOutcomeStore({ now: () => 1_000 }));
    // C(fast) ≈ 5.35 < 0.8 · C(medium) ≈ 7.5, fast is a rank down with no data.
    expect(d.best?.key).toBe(keyOf(FAST));
    expect(d.costs[keyOf(FAST)]).toBeLessThan(0.8 * d.costs[keyOf(MEDIUM)]!);
    expect(d.switched).toBe(false);
    expect(d.reasonCode).toBe("kept:evidence");
    expect(d.reason).toContain("5 recorded outcomes");
    expect(d.target).toBe(FAST); // best is still computed
    // The same without a store at all: priors alone never move a dispatch down.
    expect(priorsOnly(null).reasonCode).toBe("kept:evidence");
  });

  it("with 5 recorded outcomes on best's key the same decision switches; with 4 it is kept", () => {
    const record = (count: number) => {
      const store = createOutcomeStore({ now: () => 1_000 });
      for (let i = 0; i < count; i++) store.recordVerdict(keyOf(FAST), "pass", { attemptID: `p${i}`, step: "dispatch" });
      return store;
    };
    const five = priorsOnly(record(5));
    expect(five.reasonCode).toBe("switched");
    expect(five.switched).toBe(true);
    const four = priorsOnly(record(4));
    expect(four.reasonCode).toBe("kept:evidence");
    expect(four.best?.key).toBe(keyOf(FAST));
  });

  it("outcomes on OTHER keys do not count: the evidence must be on best's own key", () => {
    const store = createOutcomeStore({ now: () => 1_000 });
    for (let i = 0; i < 20; i++) store.recordVerdict(keyOf(MEDIUM), "fail", { attemptID: `m${i}`, step: "dispatch" });
    expect(priorsOnly(store).reasonCode).toBe("kept:evidence");
  });

  it("a switch up is not gated, with or without data", () => {
    const store = fakeStore({ p: { [keyOf(FAST)]: 0.6, [keyOf(MEDIUM)]: 0.9, [keyOf(HEAVY)]: 0.95 } }); // n = 0 everywhere
    const d = decide(input({ detection: "grader", chosen: chosenOf(FAST), store }));
    expect(d.best?.key).toBe(keyOf(MEDIUM));
    expect(d.switched).toBe(true);
    expect(d.reasonCode).toBe("switched");
  });

  it("a lower rank counts as down even when the attempt is dearer", () => {
    const low = rung("fast", "openai/gpt-6-luna-fast", "medium", 9, 0);
    const high = rung("medium", "anthropic/claude-sonnet-5-5", "xhigh", 8, 1);
    const ladder: Ladder = { candidates: [low, high], next: [null, null], classRank: 1, excluded: [] };
    const store = (n: number) => fakeStore({ p: { [keyOf(low)]: 1, [keyOf(high)]: 0.2 }, n: { [keyOf(low)]: n, [keyOf(high)]: 10 } });
    const gated = decide(input({ ladder, store: store(0), chosen: chosenOf(high), facts: mediumFacts() }));
    expect(gated.best?.key).toBe(keyOf(low));
    expect(gated.reasonCode).toBe("kept:evidence");
    expect(decide(input({ ladder, store: store(6), chosen: chosenOf(high), facts: mediumFacts() })).reasonCode).toBe("switched");
  });

  it("margin is checked first: a best that does not clear the margin reports kept:margin, not kept:evidence", () => {
    const { ladder, b } = pairLadder(7, 8);
    const store = fakeStore({ p: { [keyOf(ladder.candidates[0]!)]: 1, [keyOf(b)]: 1 } });
    expect(decide(input({ ladder, store, chosen: chosenOf(b) })).reasonCode).toBe("kept:margin");
  });

  it("hasMinEvidence: the strength of a prior, with only float jitter forgiven", () => {
    expect(MIN_EVIDENCE_TO_SWITCH_DOWN).toBe(5);
    expect(hasMinEvidence(5)).toBe(true);
    expect(hasMinEvidence(4.9999999)).toBe(true);
    expect(hasMinEvidence(4.99)).toBe(false);
    expect(hasMinEvidence(0)).toBe(false);
    expect(hasMinEvidence(Number.NaN)).toBe(false);
  });
});
describe("D9 / D13 pin", () => {
  it("pin → kept, pinned: true, best still computed", () => {
    const d = decide(input({ pin: true }));
    expect(d.pinned).toBe(true);
    expect(d.switched).toBe(false);
    expect(d.reasonCode).toBe("kept:pinned");
    expect(d.best?.key).toBe(keyOf(FAST));
    expect(d.costs[keyOf(FAST)]).toBeCloseTo(4, 10);
    expect(d.chosen.key).toBe(keyOf(HEAVY));
  });

  it("an unpinned dispatch reports pinned: false", () => {
    expect(decide(input()).pinned).toBe(false);
  });
});

describe("D9 never down a rank when risk == high and d == none", () => {
  const store = (): FakeStore =>
    fakeStore({
      p: { [keyOf(FAST)]: 0.99, [keyOf(MEDIUM)]: 0.9, [keyOf(HEAVY)]: 0.95 },
      n: { [keyOf(FAST)]: 10, [keyOf(MEDIUM)]: 10, [keyOf(HEAVY)]: 10 },
    });

  it("keeps the chosen rank; lower ranks are ineligible", () => {
    const d = decide(input({ store: store(), detection: "none", chosen: chosenOf(MEDIUM) }));
    // C(fast) = 1 + 0.01·(0.3·12.75 + 0.7·100) ≈ 1.74 < C(medium) = 12.75, but fast is a rank down.
    expect(d.costs[keyOf(FAST)]).toBeCloseTo(1 + 0.01 * (0.3 * 12.75 + 70), 10);
    expect(d.costs[keyOf(MEDIUM)]).toBeCloseTo(12.75, 10);
    expect(d.ineligible[keyOf(FAST)]).toBe("never-down");
    expect(d.best?.key).toBe(keyOf(MEDIUM));
    expect(d.switched).toBe(false);
  });

  it("moving up stays allowed, and detection lifts the rule", () => {
    const up = decide(input({ store: store(), detection: "none", chosen: chosenOf(FAST), ladder: routerLadder([FAST, MEDIUM, HEAVY]) }));
    expect(up.ineligible).toEqual({});
    const graded = decide(input({ store: store(), detection: "grader", chosen: chosenOf(MEDIUM) }));
    expect(graded.best?.key).toBe(keyOf(FAST));
    expect(graded.switched).toBe(true);
    const lowRisk = decide(input({ store: store(), detection: "none", chosen: chosenOf(MEDIUM), facts: facts({ risk: "medium" }) }));
    expect(lowRisk.ineligible[keyOf(FAST)]).toBeUndefined();
  });
});

describe("D9 gates: class confidence, needs, floor, chosen outside the ladder", () => {
  it("class confidence below minClassConfidence: kept, and the store is never read", () => {
    const store = workedStore();
    const d = decide(input({ store, facts: facts({ confidence: 0.5 }) }));
    expect(d.switched).toBe(false);
    expect(d.reasonCode).toBe("kept:class-confidence");
    expect(store.calls).toEqual({ posterior: 0, cost: 0, profile: 0 });
    expect(d.unit).toBe("ratio");
    expect(d.best).not.toBeNull();
    expect(d.confidence).toBe(0);
  });

  it("A11: a candidate whose evaluated permissions miss a need is never best", () => {
    const explore = rung("explore", "anthropic/claude-haiku-4-5", null, 1, 0, {
      agent: { origin: "host", id: "explore" },
      source: "role-own-model",
      tier: "fast",
      grants: READ_ONLY,
    });
    const ladder = routerLadder([explore, MEDIUM]);
    const store = fakeStore({ p: { [keyOf(explore)]: 0.99 } });
    const d = decide(input({ ladder, store, chosen: chosenOf(MEDIUM), detection: "deterministic", facts: facts({ needs: ["shell"] }) }));
    expect(d.ineligible[keyOf(explore)]).toBe("needs");
    expect(d.best?.key).toBe(keyOf(MEDIUM));
    const noNeeds = decide(input({ ladder, store, chosen: chosenOf(MEDIUM), detection: "deterministic" }));
    expect(noNeeds.best?.key).toBe(keyOf(explore));
    expect(noNeeds.target?.agent).toEqual({ origin: "host", id: "explore" });
    const unknownPerms = routerLadder([{ ...explore, grants: null }, MEDIUM]);
    const d2 = decide(input({ ladder: unknownPerms, store, chosen: chosenOf(MEDIUM), facts: facts({ needs: ["edit"] }) }));
    expect(d2.ineligible[keyOf(explore)]).toBe("needs");
  });

  it("floorTier: candidates below the floor rank are never best", () => {
    const d = decide(input({ floorRank: 1 }));
    expect(d.ineligible[keyOf(FAST)]).toBe("floor");
    expect(d.best?.key).toBe(keyOf(MEDIUM));
    expect(d.switched).toBe(true);
  });

  it("a chosen dispatch outside the ladder is kept, best still computed", () => {
    const d = decide(input({ chosen: { agent: { origin: "host", id: "general" }, model: "anthropic/claude-sonnet-5-5", variant: null } }));
    expect(d.reasonCode).toBe("kept:chosen-not-candidate");
    expect(d.switched).toBe(false);
    expect(d.chosen).toEqual({
      key: "implement|host:general|anthropic/claude-sonnet-5-5#default",
      agent: "general",
      origin: "host",
      model: "anthropic/claude-sonnet-5-5",
      variant: "default",
    });
    expect(d.best?.key).toBe(keyOf(FAST));
  });

  it("an empty ladder is kept with a reason", () => {
    const d = decide(input({ ladder: { candidates: [], next: [], classRank: null, excluded: [] } }));
    expect(d).toMatchObject({ best: null, switched: false, reasonCode: "kept:no-candidates", unit: "ratio", costs: {}, target: null });
  });

  it("a candidate with an unusable costRatio is ineligible and a give-up as a successor", () => {
    const broken = { ...MEDIUM, costRatio: Number.NaN };
    const d = decide(input({ ladder: routerLadder([FAST, broken, HEAVY]), chosen: chosenOf(FAST) }));
    expect(d.costs[keyOf(MEDIUM)]).toBeUndefined();
    expect(d.ineligible[keyOf(MEDIUM)]).toBe("invalid-cost");
    expect(d.costs[keyOf(FAST)]).toBeCloseTo(1 + 0.4 * 100, 10);
    const onlyBroken = decide(input({ ladder: routerLadder([broken]), chosen: chosenOf(MEDIUM) }));
    expect(onlyBroken.best).toBeNull();
    expect(onlyBroken.reasonCode).toBe("kept:no-candidates");
  });

  it("duplicate keys are priced once (first rung wins)", () => {
    const d = decide(input({ ladder: { ...routerLadder([FAST, FAST, HEAVY]), next: [2, 2, null] }, chosen: chosenOf(HEAVY) }));
    expect(Object.keys(d.costs)).toEqual([keyOf(FAST), keyOf(HEAVY)]);
  });
});

// ---------------------------------------------------------------------------
// D5 unit rule, tax, confidence
// ---------------------------------------------------------------------------

describe("D5 unit rule and the tax term", () => {
  const priced = (c: Candidate): Candidate => ({ ...c, pricing: PRICED });
  const F = priced(FAST);
  const M = priced(MEDIUM);
  const H = priced(HEAVY);
  const p = { [keyOf(F)]: 0.6, [keyOf(M)]: 0.9, [keyOf(H)]: 0.95 };

  it("compares in USD when every candidate is USD-comparable; U is scaled by USD per ratio unit", () => {
    const store = fakeStore({ p, cost: { [keyOf(F)]: measured(0.01), [keyOf(M)]: measured(0.05), [keyOf(H)]: measured(0.2) } });
    const d = decide(input({ ladder: routerLadder([F, M, H]), store }));
    // USD per ratio unit = 0.01 / 1 → U = 1. Same shape as the ratio example, divided by 100.
    expect(d.unit).toBe("usd");
    expect(d.costs[keyOf(H)]).toBeCloseTo(0.25, 12);
    expect(d.costs[keyOf(M)]).toBeCloseTo(0.075, 12);
    expect(d.costs[keyOf(F)]).toBeCloseTo(0.04, 12);
  });

  it("switches to ratio units for every candidate when one is unpriced and unmeasured (never mixed)", () => {
    const unpricedHeavy = { ...HEAVY, pricing: UNPRICED };
    const store = fakeStore({ p, cost: { [keyOf(F)]: measured(0.01), [keyOf(M)]: measured(0.05) } });
    const d = decide(input({ ladder: routerLadder([F, M, unpricedHeavy]), store }));
    expect(d.unit).toBe("ratio");
    expect(d.costs[keyOf(H)]).toBeCloseTo(25, 10);
    expect(d.costs[keyOf(M)]).toBeCloseTo(7.5, 10);
    expect(d.costs[keyOf(F)]).toBeCloseTo(4, 10);
  });

  it("A1: candidates without catalog pricing compare in ratio units", () => {
    const d = decide(input());
    expect(d.unit).toBe("ratio");
  });

  it("falls back to ratio when the USD scale cannot be derived", () => {
    const store = fakeStore({ p, cost: { [keyOf(F)]: measured(0), [keyOf(M)]: measured(0.05), [keyOf(H)]: measured(0.2) } });
    expect(decide(input({ ladder: routerLadder([F, M, H]), store })).unit).toBe("ratio");
    const invalidRatios = routerLadder([{ ...F, costRatio: 0 }, { ...M, costRatio: Number.NaN }]);
    const store2 = fakeStore({ p, cost: { [keyOf(F)]: measured(0.01), [keyOf(M)]: measured(0.05) } });
    expect(decide(input({ ladder: invalidRatios, store: store2, chosen: chosenOf(F) })).unit).toBe("ratio");
  });

  it("tax is 0 until measured, and added in USD once the final message was measured", () => {
    const orchestrator = { pricing: PRICED, contextTokens: 10_000 };
    const base = { [keyOf(F)]: measured(0.01), [keyOf(M)]: measured(0.05), [keyOf(H)]: measured(0.2) };
    const unmeasured = decide(input({ ladder: routerLadder([F, M, H]), store: fakeStore({ p, cost: base }), orchestrator }));
    expect(unmeasured.costs[keyOf(H)]).toBeCloseTo(0.25, 12);

    const withFinal = {
      ...base,
      [keyOf(H)]: measured(0.2, { finalMessageTokens: { mean: 1000, n: 2 } }),
    };
    const taxed = decide(input({ ladder: routerLadder([F, M, H]), store: fakeStore({ p, cost: withFinal }), orchestrator }));
    // 1000 tokens · 4 turns · $0.3 / 1e6 = 0.0012
    expect(taxed.costs[keyOf(H)]).toBeCloseTo(0.2512, 12);
    const twoTurns = decide(input({ ladder: routerLadder([F, M, H]), store: fakeStore({ p, cost: withFinal }), orchestrator, remainingTurns: 2 }));
    expect(twoTurns.costs[keyOf(H)]).toBeCloseTo(0.2506, 12);
    const noOrchestrator = decide(input({ ladder: routerLadder([F, M, H]), store: fakeStore({ p, cost: withFinal }) }));
    expect(noOrchestrator.costs[keyOf(H)]).toBeCloseTo(0.25, 12);
    const badTurns = decide(input({ ladder: routerLadder([F, M, H]), store: fakeStore({ p, cost: withFinal }), orchestrator, remainingTurns: Number.NaN }));
    expect(badTurns.costs[keyOf(H)]).toBeCloseTo(0.2512, 12);
  });

  it("tax is always 0 in ratio units, even when measured", () => {
    const store = fakeStore({ p: { [keyOf(FAST)]: 0.6, [keyOf(MEDIUM)]: 0.9, [keyOf(HEAVY)]: 0.95 }, cost: {
      [keyOf(HEAVY)]: { ...emptyCostStats(), finalMessageTokens: { mean: 1000, n: 5 } },
    } });
    const d = decide(input({ store, orchestrator: { pricing: PRICED, contextTokens: 0 } }));
    expect(d.unit).toBe("ratio");
    expect(d.costs[keyOf(HEAVY)]).toBeCloseTo(25, 10);
  });

  it("uses the class token profile to make priced candidates USD-comparable", () => {
    const profile: TokenMeans = { n: 4, input: 10_000, output: 1_000, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
    const store = fakeStore({ p, profile });
    const d = decide(input({ ladder: routerLadder([F, M, H]), store }));
    expect(d.unit).toBe("usd");
    // Every rung shares the profile and the price: c = 0.03 + 0.015 = 0.045 each, U = 100 · 0.045.
    expect(d.costs[keyOf(H)]).toBeCloseTo(0.045 + 0.05 * 4.5, 12);
  });

  it("decision confidence weighs the class confidence by best's evidence", () => {
    const store = fakeStore({ p: { [keyOf(FAST)]: 0.6, [keyOf(MEDIUM)]: 0.9, [keyOf(HEAVY)]: 0.95 }, n: { [keyOf(FAST)]: 5 } });
    expect(decide(input({ store })).confidence).toBe(0.45);
  });

  it("a non-finite posterior falls back to the prior; non-finite detection counts as d = 0", () => {
    const store = fakeStore({ p: { [keyOf(FAST)]: Number.NaN }, n: { [keyOf(FAST)]: Number.NaN } });
    const lone = routerLadder([FAST], 0);
    const d = decide(input({ store, ladder: lone, chosen: chosenOf(FAST) }));
    expect(d.costs[keyOf(FAST)]).toBeCloseTo(1 + 0.2 * 100, 10);
    expect(d.confidence).toBe(0);
    const noD = decide(input({ routing: { ...ROUTING, detection: { deterministic: Number.NaN, grader: 0.5, none: 0.3 } } }));
    // d = 0: C(fast) = 1 + 0.4·100.
    expect(noD.costs[keyOf(FAST)]).toBeCloseTo(41, 10);
  });
});

// ---------------------------------------------------------------------------
// Purity: memoisation per call, frozen inputs/outputs, property, speed
// ---------------------------------------------------------------------------

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

describe("purity", () => {
  it("memoisation does not leak across calls on the same ladder object", () => {
    const ladder = deepFreeze(routerLadder());
    const first = decide(input({ ladder, detection: "deterministic" }));
    const second = decide(input({ ladder, detection: "grader", chosen: chosenOf(FAST) }));
    const third = decide(input({ ladder, detection: "deterministic", store: fakeStore({ p: { [keyOf(FAST)]: 0.1 } }) }));
    const again = decide(input({ ladder, detection: "deterministic" }));
    expect(first.costs[keyOf(FAST)]).toBeCloseTo(4, 10);
    expect(second.costs[keyOf(FAST)]).toBeCloseTo(23.25, 10);
    expect(third.costs[keyOf(FAST)]).not.toBeCloseTo(4, 3);
    expect(again.costs).toEqual(first.costs);
  });

  it("returns frozen decisions and never mutates its input", () => {
    // The store view is a live object (it counts calls); everything else is frozen deep.
    const i = Object.freeze({
      ...input(),
      facts: deepFreeze(facts({ needs: ["edit"] })),
      chosen: deepFreeze(chosenOf(HEAVY)),
      ladder: deepFreeze(routerLadder()),
      routing: deepFreeze({ ...ROUTING, detection: { ...ROUTING.detection } }),
    });
    const d = decide(i);
    expect(Object.isFrozen(d)).toBe(true);
    expect(Object.isFrozen(d.costs)).toBe(true);
    expect(Object.isFrozen(d.ineligible)).toBe(true);
    expect(Object.isFrozen(d.chosen)).toBe(true);
  });

  it("property: random graphs (cycles included) give finite costs ≥ c_k and best is the eligible argmin", () => {
    let seed = 42;
    const rand = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    for (let trial = 0; trial < 300; trial++) {
      const n = 1 + Math.floor(rand() * 12);
      const cands: Candidate[] = [];
      const p: Record<string, number> = {};
      for (let k = 0; k < n; k++) {
        const c = rung(`t${k}`, `prov/m${k}`, rand() < 0.5 ? null : "high", 0.5 + rand() * 30, Math.floor(rand() * 3));
        cands.push(c);
        p[keyOf(c)] = rand();
      }
      const next = cands.map(() => (rand() < 0.25 ? null : Math.floor(rand() * n)));
      const ladder: Ladder = { candidates: cands, next, classRank: 1, excluded: [] };
      const chosen = cands[Math.floor(rand() * n)]!;
      const detection = (["deterministic", "grader", "none"] as const)[Math.floor(rand() * 3)]!;
      const d = decide(input({ ladder, store: fakeStore({ p }), chosen: chosenOf(chosen), detection }));
      for (const c of cands) {
        const cost = d.costs[keyOf(c)]!;
        expect(Number.isFinite(cost)).toBe(true);
        expect(cost).toBeGreaterThanOrEqual(c.costRatio - 1e-9);
      }
      const eligible = cands.filter((c) => keyOf(c) === keyOf(chosen) || d.ineligible[keyOf(c)] === undefined);
      const min = Math.min(...eligible.map((c) => d.costs[keyOf(c)]!));
      expect(d.costs[d.best!.key]).toBe(min);
      if (d.switched) expect(d.costs[d.best!.key]!).toBeLessThan((1 - ROUTING.margin) * d.costs[keyOf(chosen)]!);
    }
  });

  it("decides 12 candidates in under 2 ms", () => {
    const cands: Candidate[] = [];
    const tiers = ["fast", "medium", "heavy"] as const;
    const variants = ["low", "medium", "high", "xhigh"] as const;
    for (const [rank, tier] of tiers.entries()) {
      for (const [i, v] of variants.entries()) cands.push(rung(tier, `anthropic/model-${tier}`, v, (rank * 4 + i + 1) * 1.5, rank));
    }
    const store = createOutcomeStore({ now: () => 0 });
    for (const [i, c] of cands.entries()) {
      store.recordVerdict(keyOf(c), i % 3 === 0 ? "fail" : "pass", { attemptID: `x${i}`, step: "dispatch" });
    }
    const ladder = routerLadder(cands);
    const args = input({ ladder, store, chosen: chosenOf(cands[11]!) });
    for (let i = 0; i < 50; i++) decide(args); // warm-up
    const runs = 200;
    const times: number[] = [];
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      decide(args);
      times.push(performance.now() - t0);
    }
    times.sort((x, y) => x - y);
    expect(times[Math.floor(runs / 2)]!).toBeLessThan(2);
  });
});
