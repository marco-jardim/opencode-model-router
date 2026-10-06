import { describe, it, expect } from "vitest";
import { createOutcomeStore, parseSnapshot } from "../../src/routing/outcomes/store";
import { DAY_MS, SAME_RANK_PRIOR, priorForRankOffset } from "../../src/routing/outcomes/beta";
import { emptyCostStats, emptyTokenSample } from "../../src/routing/outcomes/cost";
import {
  OUTCOMES_SCHEMA_ID,
  classifyAgentOrigin,
  makeKey,
  normalizeVariant,
  parseKey,
} from "../../src/routing/outcomes/types";
import type {
  AgentRef,
  AttemptSignal,
  OutcomeKey,
  OutcomeSnapshot,
  StepSample,
  TokenSample,
} from "../../src/routing/outcomes/types";

const T0 = Date.UTC(2026, 9, 6, 12, 0, 0);

function clock(start = T0) {
  let t = start;
  return {
    now: () => t,
    set(value: number) {
      t = value;
    },
    advance(ms: number) {
      t += ms;
    },
  };
}

const router = (id: string): AgentRef => ({ origin: "router", id });
const host = (id: string): AgentRef => ({ origin: "host", id });
const K = (cls = "implement", agent: AgentRef = router("medium"), model = "claude-sonnet-5-5", variant?: string | null): OutcomeKey =>
  makeKey(cls, agent, "anthropic", model, variant);

function signal(attemptID: string, step: AttemptSignal["step"] = "dispatch"): AttemptSignal {
  return { attemptID, step };
}

function tokens(partial: Partial<TokenSample> = {}): TokenSample {
  return { ...emptyTokenSample(), ...partial };
}

function step(attemptID: string, partial: Partial<StepSample> = {}): StepSample {
  return { attemptID, cost: 0.1, pricing: "priced", tokens: tokens({ input: 100, output: 10 }), final: false, ...partial };
}

describe("outcome keys (store-facing)", () => {
  it("absent, null and empty variants all normalise to `default` and hit one key", () => {
    const variants: Array<string | null | undefined> = [undefined, null, "", "default"];
    const keys = new Set(variants.map((v) => K("implement", router("medium"), "claude-sonnet-5-5", v)));
    expect([...keys]).toEqual(["implement|router:medium|anthropic/claude-sonnet-5-5#default"]);
    expect(normalizeVariant(undefined)).toBe("default");
    expect(normalizeVariant(null)).toBe("default");
    expect(normalizeVariant("")).toBe("default");
    expect(normalizeVariant("High")).toBe("High");

    const store = createOutcomeStore({ now: clock().now });
    store.recordVerdict(K("implement", router("medium"), "claude-sonnet-5-5", undefined), "pass", signal("a1"));
    store.recordVerdict(K("implement", router("medium"), "claude-sonnet-5-5", null), "pass", signal("a2"));
    store.recordStep(K("implement", router("medium"), "claude-sonnet-5-5", ""), step("a3", { final: true }));
    expect(store.keys()).toEqual(["implement|router:medium|anthropic/claude-sonnet-5-5#default"]);
    expect(store.posterior(K()).n).toBeCloseTo(2, 12);
  });

  it("an empty class, agent id, provider or model never throws and is normalised", () => {
    expect(makeKey("", router(""), "", "")).toBe("other|router:unknown|unknown/unknown#default");
    expect(parseKey(makeKey("", router(""), "", ""))).toEqual({
      cls: "other",
      agent: router("unknown"),
      provider: "unknown",
      model: "unknown",
      variant: "default",
    });
  });

  it("router and host agents with the same id on the same model are two keys with independent posteriors", () => {
    const routerKey = K("search", router("explore"), "claude-haiku-4-5");
    const hostKey = K("search", host("explore"), "claude-haiku-4-5");
    expect(routerKey).not.toBe(hostKey);
    expect(hostKey).toBe("search|host:explore|anthropic/claude-haiku-4-5#default");

    const store = createOutcomeStore({ now: clock().now });
    for (let i = 0; i < 5; i++) store.recordVerdict(hostKey, "fail", signal(`h${i}`));
    for (let i = 0; i < 5; i++) store.recordVerdict(routerKey, "pass", signal(`r${i}`));
    expect(store.posterior(hostKey).mean).toBeCloseTo(4 / 10, 12);
    expect(store.posterior(routerKey).mean).toBeCloseTo(9 / 10, 12);
    expect(store.keys()).toEqual([hostKey, routerKey].sort());
  });

  it("classifyAgentOrigin: router iff the id names a router tier of the active preset", () => {
    expect(classifyAgentOrigin("fast", new Set(["fast", "medium", "heavy"]))).toBe("router");
    expect(classifyAgentOrigin("explore", new Set(["fast", "medium", "heavy"]))).toBe("host");
    expect(classifyAgentOrigin("medium", ["fast", "medium"])).toBe("router");
    expect(classifyAgentOrigin("general", [])).toBe("host");
  });

  it("escaped delimiters round-trip through makeKey/parseKey and through the store", () => {
    const parts = { cls: "we|ird#cls:/x", agent: host("a:b|c%d"), provider: "pr/ov", model: "mo:del/x#y%", variant: "v|1#2" };
    const key = makeKey(parts.cls, parts.agent, parts.provider, parts.model, parts.variant);
    expect(key.split("|")).toHaveLength(3);
    expect(parseKey(key)).toEqual(parts);

    const store = createOutcomeStore({ now: clock().now });
    store.recordVerdict(key, "pass", signal("x"));
    const snapshot = store.snapshot();
    expect(Object.keys(snapshot.entries)).toEqual([key]);
    const other = createOutcomeStore({ now: clock().now });
    expect(other.fromSnapshot(snapshot)).toEqual({ accepted: 1, dropped: 0 });
    expect(other.keys()).toEqual([key]);
    expect(other.classTokenProfile(parts.cls)).toBeNull();
  });

  it("parseKey(makeKey(p)) equals p for random normalized parts", () => {
    let seed = 7;
    const rnd = (n: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    const alphabet = ["a", "B", "%", "|", "#", ":", "/", " ", "é", "1", "%7C", "%25"];
    const part = (): string => Array.from({ length: 1 + rnd(4) }, () => alphabet[rnd(alphabet.length)]).join("");
    for (let i = 0; i < 2000; i++) {
      const p = {
        cls: part(),
        agent: { origin: rnd(2) === 0 ? ("router" as const) : ("host" as const), id: part() },
        provider: part(),
        model: part(),
        variant: part(),
      };
      expect(parseKey(makeKey(p.cls, p.agent, p.provider, p.model, p.variant))).toEqual(p);
    }
  });

  it("QA-1.3-12: parseKey accepts only canonical keys (makeKey(parts) === key)", () => {
    const canonical = "implement|router:medium|anthropic/claude:beta/x#default";
    const parts = parseKey(canonical);
    expect(parts).not.toBeNull(); // `:` and `/` stay readable inside the model segment
    if (parts) expect(makeKey(parts.cls, parts.agent, parts.provider, parts.model, parts.variant)).toBe(canonical);

    const aliases = [
      "imp:lement|router:medium|anthropic/m#default", // unescaped `:` in the class
      "implement|router:a/b|anthropic/m#default", // unescaped `/` in the agent id
      "implement|router:medium|anth:ropic/m#default", // unescaped `:` in the provider
      "implement|router:medium|anthropic/m#de:fault", // unescaped `:` in the variant
      "implement|router:medium|anthropic/m#de/fault", // unescaped `/` in the variant
      "implement|router:me%7cdium|anthropic/m#default", // lowercase escape
      "imp%3alement|router:medium|anthropic/m#default", // lowercase escape
      "implement|router:medium|anthropic/m%41#default", // unknown escape
    ];
    for (const alias of aliases) expect(parseKey(alias), alias).toBeNull();

    // an alias can no longer smuggle itself into the store as a second key for the same evidence
    const store = createOutcomeStore({ now: clock().now });
    expect(store.recordVerdict(aliases[1] as OutcomeKey, "pass", signal("x"))).toBe(false);
    expect(store.keys()).toEqual([]);
  });
  it("keys() sorts by code unit, not by locale", () => {
    const store = createOutcomeStore({ now: clock().now });
    const lower = K("a");
    const upper = K("B");
    store.recordVerdict(lower, "pass", signal("1"));
    store.recordVerdict(upper, "pass", signal("2"));
    expect(store.keys()).toEqual([upper, lower]);
    expect(Object.keys(store.snapshot().entries)).toEqual([upper, lower]);
  });
});

describe("posterior", () => {
  it("an unknown key returns exactly the same-rank prior Beta(4, 1)", () => {
    const store = createOutcomeStore({ now: clock().now });
    const p = store.posterior(K("never-seen"));
    expect(p).toEqual({ alpha: 4, beta: 1, mean: 0.8, n: 0, prior: { alpha: 4, beta: 1 } });
    expect(store.revision).toBe(0);
    expect(store.keys()).toEqual([]);
  });

  it("an explicit prior is returned exactly for an unknown key and is added to evidence for a known one", () => {
    const store = createOutcomeStore({ now: clock().now });
    const prior = priorForRankOffset(-1);
    const unknown = store.posterior(K("x"), prior);
    expect(unknown.alpha).toBe(prior.alpha);
    expect(unknown.beta).toBe(prior.beta);
    expect(unknown.mean).toBe(prior.alpha / 5);
    store.recordVerdict(K("x"), "pass", signal("a"));
    const known = store.posterior(K("x"), prior);
    expect(known.alpha).toBe(prior.alpha + 1);
    expect(known.beta).toBe(prior.beta);
    expect(known.n).toBe(1);
  });

  it("reading never mutates the store (no revision bump, no snapshot change), even far in the future", () => {
    const c = clock();
    const store = createOutcomeStore({ now: c.now });
    store.recordVerdict(K(), "pass", signal("a"));
    store.recordVerdict(K(), "fail", signal("b"));
    const revision = store.revision;
    const snapshot = JSON.stringify(store.snapshot());
    for (const days of [0, 1, 14, 100, 10_000]) {
      c.set(T0 + days * DAY_MS);
      store.posterior(K());
      store.posterior(K("unknown"));
      store.cost(K());
    }
    expect(store.revision).toBe(revision);
    expect(JSON.stringify(store.snapshot())).toBe(snapshot);
  });

  it("a clock going backwards does not inflate the posterior", () => {
    const c = clock();
    const store = createOutcomeStore({ now: c.now });
    store.recordVerdict(K(), "pass", signal("a"));
    const atT = store.posterior(K());
    c.set(T0 - DAY_MS);
    expect(store.posterior(K())).toEqual(atT);
    store.recordVerdict(K(), "pass", signal("b"));
    c.set(T0);
    expect(store.posterior(K()).n).toBeCloseTo(2, 12);
  });

  it("configure() changes decay and cap lazily without rewriting stored evidence", () => {
    const c = clock();
    const store = createOutcomeStore({ now: c.now, halfLifeDays: 14, maxEffectiveSamples: 50 });
    for (let i = 0; i < 20; i++) store.recordVerdict(K(), "pass", signal(`a${i}`));
    const before = JSON.stringify(store.snapshot());
    store.configure({ maxEffectiveSamples: 10 });
    expect(store.posterior(K()).n).toBeCloseTo(10, 12);
    expect(JSON.stringify(store.snapshot())).toBe(before);
    store.configure({ halfLifeDays: 1, maxEffectiveSamples: 50 });
    c.advance(DAY_MS);
    expect(store.posterior(K()).n).toBeCloseTo(10, 12);
    // a NaN half-life is sanitised back to the 14-day default; evidence is still expressed at T0 (15 days ago)
    store.configure({ halfLifeDays: Number.NaN });
    c.advance(14 * DAY_MS);
    expect(store.posterior(K()).n).toBeCloseTo(20 * 2 ** (-15 / 14), 9);
    expect(JSON.stringify(store.snapshot())).toBe(before);
  });
});

describe("recordVerdict (D4)", () => {
  it("pass and fail update the Beta, the counters and the revision", () => {
    const store = createOutcomeStore({ now: clock().now });
    expect(store.recordVerdict(K(), "pass", signal("a"))).toBe(true);
    expect(store.revision).toBe(1);
    expect(store.recordVerdict(K(), "fail", signal("b"))).toBe(true);
    expect(store.revision).toBe(2);
    const entry = store.snapshot().entries[K()];
    expect(entry?.counts).toEqual({ pass: 1, fail: 1, falseRefusals: 0, variantPass: 0, variantFail: 0 });
    expect(entry?.beta).toEqual({ alpha: 1, beta: 1, updatedAt: T0 });
    const p = store.posterior(K());
    expect(p.alpha).toBe(5);
    expect(p.beta).toBe(2);
  });

  it("unverifiable is a strict no-op: false, no revision bump, snapshot deep-equal", () => {
    const store = createOutcomeStore({ now: clock().now });
    store.recordVerdict(K(), "pass", signal("a"));
    const before = store.snapshot();
    const revision = store.revision;
    expect(store.recordVerdict(K(), "unverifiable", signal("b"))).toBe(false);
    expect(store.recordVerdict(K("fresh"), "unverifiable", signal("c"))).toBe(false);
    expect(store.revision).toBe(revision);
    expect(store.snapshot()).toEqual(before);
    expect(store.keys()).toEqual([K()]);
    // the attempt is not consumed: a later real verdict for it still counts
    expect(store.recordVerdict(K(), "fail", signal("b"))).toBe(true);
  });

  it("an unexpected verdict value is also a no-op", () => {
    const store = createOutcomeStore({ now: clock().now });
    expect(store.recordVerdict(K(), "maybe" as unknown as "pass", signal("a"))).toBe(false);
    expect(store.revision).toBe(0);
  });

  it("one observation per attempt: a second verdict for the same attempt is ignored", () => {
    const store = createOutcomeStore({ now: clock().now });
    expect(store.recordVerdict(K(), "pass", signal("a"))).toBe(true);
    const revision = store.revision;
    expect(store.recordVerdict(K(), "fail", signal("a"))).toBe(false);
    expect(store.recordVerdict(K("other"), "fail", signal("a"))).toBe(false);
    expect(store.revision).toBe(revision);
    expect(store.snapshot().entries[K()]?.counts.fail).toBe(0);
    expect(store.keys()).toEqual([K()]);
  });

  it("variant attempts also feed the variant counters", () => {
    const store = createOutcomeStore({ now: clock().now });
    store.recordVerdict(K(), "pass", signal("a", "variant"));
    store.recordVerdict(K(), "fail", signal("b", "variant"));
    store.recordVerdict(K(), "pass", signal("c", "retry"));
    expect(store.snapshot().entries[K()]?.counts).toEqual({ pass: 2, fail: 1, falseRefusals: 0, variantPass: 1, variantFail: 1 });
  });

  it("the dedupe set is an LRU capped at maxScoredAttempts", () => {
    const store = createOutcomeStore({ now: clock().now, maxScoredAttempts: 2 });
    expect(store.recordVerdict(K(), "pass", signal("a1"))).toBe(true);
    expect(store.recordVerdict(K(), "pass", signal("a2"))).toBe(true);
    expect(store.recordVerdict(K(), "pass", signal("a1"))).toBe(false); // refreshes a1
    expect(store.recordVerdict(K(), "pass", signal("a3"))).toBe(true); // evicts a2
    expect(store.recordVerdict(K(), "pass", signal("a1"))).toBe(false);
    expect(store.recordVerdict(K(), "pass", signal("a2"))).toBe(true); // forgotten
  });

  it("a malformed key is ignored instead of throwing", () => {
    const store = createOutcomeStore({ now: clock().now });
    const bad = "garbage" as unknown as OutcomeKey;
    expect(store.recordVerdict(bad, "pass", signal("a"))).toBe(false);
    expect(store.recordFalseRefusal(bad, signal("b"))).toBe(false);
    expect(store.revision).toBe(0);
    expect(store.keys()).toEqual([]);
  });
});

describe("recordFalseRefusal (D4: a false refusal is a failure)", () => {
  it("counts as a failure, bumps the revision and returns true on the first signal of an attempt", () => {
    const store = createOutcomeStore({ now: clock().now });
    expect(store.recordFalseRefusal(K(), signal("a"))).toBe(true);
    expect(store.revision).toBe(1);
    const entry = store.snapshot().entries[K()];
    expect(entry?.counts).toEqual({ pass: 0, fail: 0, falseRefusals: 1, variantPass: 0, variantFail: 0 });
    expect(entry?.beta).toEqual({ alpha: 0, beta: 1, updatedAt: T0 });
    expect(store.posterior(K()).mean).toBeCloseTo(4 / 6, 12);
  });

  it("a refusal before the verdict of the same attempt consumes the observation (C5)", () => {
    const store = createOutcomeStore({ now: clock().now });
    expect(store.recordFalseRefusal(K(), signal("a"))).toBe(true);
    expect(store.recordVerdict(K(), "pass", signal("a"))).toBe(false);
    expect(store.posterior(K()).n).toBe(1);
    expect(store.snapshot().entries[K()]?.counts.pass).toBe(0);
  });

  it("a refusal after a fail verdict (or a second refusal) only bumps the lifetime counter and the revision", () => {
    const store = createOutcomeStore({ now: clock().now });
    store.recordVerdict(K(), "fail", signal("a"));
    const revision = store.revision;
    expect(store.recordFalseRefusal(K(), signal("a"))).toBe(false);
    expect(store.revision).toBe(revision + 1);
    expect(store.posterior(K()).n).toBe(1);
    expect(store.snapshot().entries[K()]?.counts).toMatchObject({ fail: 1, falseRefusals: 1 });
    store.recordFalseRefusal(K(), signal("b"));
    expect(store.recordFalseRefusal(K(), signal("b"))).toBe(false);
    expect(store.snapshot().entries[K()]?.counts.falseRefusals).toBe(3);
  });

  it("QA-1.3-6: a refusal after a pass converts it into a failure (beta, counters, return value)", () => {
    const store = createOutcomeStore({ now: clock().now });
    expect(store.recordVerdict(K(), "pass", signal("a"))).toBe(true);
    const revision = store.revision;
    expect(store.recordFalseRefusal(K(), signal("a"))).toBe(true);
    expect(store.revision).toBe(revision + 1);
    const entry = store.snapshot().entries[K()];
    expect(entry?.beta).toEqual({ alpha: 0, beta: 1, updatedAt: T0 });
    expect(entry?.counts).toEqual({ pass: 0, fail: 1, falseRefusals: 1, variantPass: 0, variantFail: 0 });
    expect(store.posterior(K()).mean).toBeCloseTo(4 / 6, 12); // same as a refusal-first attempt
    // the attempt stays scored: later signals do nothing more
    expect(store.recordVerdict(K(), "pass", signal("a"))).toBe(false);
    expect(store.recordFalseRefusal(K(), signal("a"))).toBe(false);
    expect(store.snapshot().entries[K()]?.beta).toEqual({ alpha: 0, beta: 1, updatedAt: T0 });
    expect(store.snapshot().entries[K()]?.counts).toMatchObject({ pass: 0, fail: 1, falseRefusals: 2 });
  });

  it("QA-1.3-6: the pass's contribution is taken out at its decayed weight, other evidence stays", () => {
    const c = clock();
    const store = createOutcomeStore({ now: c.now });
    store.recordVerdict(K(), "pass", signal("old"));
    store.recordVerdict(K(), "pass", signal("a"));
    store.recordVerdict(K(), "pass", signal("older-fail-free"));
    c.advance(14 * DAY_MS); // one half-life later
    expect(store.recordFalseRefusal(K(), signal("a"))).toBe(true);
    const beta = store.snapshot().entries[K()]?.beta;
    expect(beta?.alpha).toBeCloseTo(3 * 0.5 - 0.5, 12);
    expect(beta?.beta).toBeCloseTo(1, 12);
    expect(beta?.updatedAt).toBe(T0 + 14 * DAY_MS);
    expect(store.snapshot().entries[K()]?.counts).toMatchObject({ pass: 2, fail: 1, falseRefusals: 1 });
  });

  it("QA-1.3-6: variant counters move with the conversion", () => {
    const store = createOutcomeStore({ now: clock().now });
    store.recordVerdict(K(), "pass", signal("a", "variant"));
    store.recordVerdict(K(), "pass", signal("b"));
    expect(store.snapshot().entries[K()]?.counts).toMatchObject({ pass: 2, variantPass: 1, variantFail: 0 });
    expect(store.recordFalseRefusal(K(), signal("a", "variant"))).toBe(true);
    expect(store.snapshot().entries[K()]?.counts).toEqual({ pass: 1, fail: 1, falseRefusals: 1, variantPass: 0, variantFail: 1 });
    expect(store.snapshot().entries[K()]?.beta.alpha).toBe(1);
  });

  it("QA-1.3-6: alpha and the pass counter are floored at 0 when the evidence behind the attempt is gone", () => {
    const store = createOutcomeStore({ now: clock().now });
    store.recordVerdict(K(), "pass", signal("x"));
    store.fromSnapshot({ version: 1, entries: {} }); // e.g. a replace-load wiped the evidence; the attempt is still remembered
    expect(store.recordFalseRefusal(K(), signal("x"))).toBe(true);
    const after = store.snapshot().entries[K()];
    expect(after?.beta.alpha).toBe(0);
    expect(after?.beta.beta).toBe(1);
    expect(after?.counts).toEqual({ pass: 0, fail: 1, falseRefusals: 1, variantPass: 0, variantFail: 0 });
  });
  it("QA-1.3-6: a refusal for an attempt scored under another key does not convert it", () => {
    const store = createOutcomeStore({ now: clock().now });
    store.recordVerdict(K("one"), "pass", signal("a"));
    expect(store.recordFalseRefusal(K("two"), signal("a"))).toBe(false);
    expect(store.snapshot().entries[K("one")]?.counts).toMatchObject({ pass: 1, fail: 0 });
    expect(store.snapshot().entries[K("two")]?.counts).toMatchObject({ falseRefusals: 1 });
  });

  it("a variant refusal also counts as a variant failure", () => {
    const store = createOutcomeStore({ now: clock().now });
    store.recordFalseRefusal(K(), signal("a", "variant"));
    expect(store.snapshot().entries[K()]?.counts).toEqual({ pass: 0, fail: 0, falseRefusals: 1, variantPass: 0, variantFail: 1 });
  });
});

describe("recordStep and closeAttempt (D6, C4)", () => {
  it("steps accumulate in an open attempt and fold into cost(key) on the final step", () => {
    const store = createOutcomeStore({ now: clock().now });
    store.recordStep(K(), step("c:0", { cost: 0.1, tokens: tokens({ input: 100, output: 10 }) }));
    expect(store.revision).toBe(0);
    expect(store.cost(K()).tokens.n).toBe(0);
    store.recordStep(K(), step("c:0", { cost: 0.2, tokens: tokens({ input: 200, output: 30, cacheRead: 5 }), final: true }));
    expect(store.revision).toBe(1);
    const c = store.cost(K());
    expect(c.measuredUSD.n).toBe(1);
    expect(c.measuredUSD.mean).toBeCloseTo(0.3, 12);
    expect(c.tokens).toEqual({ n: 1, input: 300, output: 40, reasoning: 0, cacheRead: 5, cacheWrite: 0 });
    expect(c.steps).toEqual({ mean: 2, n: 1 });
    expect(c.finalMessageTokens).toEqual({ mean: 30, n: 1 });
    expect(c.unpricedAttempts).toBe(0);
  });

  it("steps after an attempt's final step are ignored (host housekeeping)", () => {
    const store = createOutcomeStore({ now: clock().now });
    store.recordStep(K(), step("c:0", { final: true }));
    const revision = store.revision;
    const before = JSON.stringify(store.snapshot());
    store.recordStep(K(), step("c:0", { cost: 5, final: true }));
    store.recordStep(K("other"), step("c:0"));
    expect(store.revision).toBe(revision);
    expect(JSON.stringify(store.snapshot())).toBe(before);
  });

  it("cost 0 on an unpriced model is excluded from the USD mean but its tokens are kept (A1)", () => {
    const store = createOutcomeStore({ now: clock().now });
    store.recordStep(K(), step("c:0", { cost: 0, pricing: "unpriced", tokens: tokens({ input: 500, output: 50 }), final: true }));
    const c = store.cost(K());
    expect(c.measuredUSD).toEqual({ mean: 0, n: 0 });
    expect(c.unpricedAttempts).toBe(1);
    expect(c.tokens.n).toBe(1);
    expect(c.tokens.input).toBe(500);
  });

  it("a priced model's zero-cost step stays a measured 0", () => {
    const store = createOutcomeStore({ now: clock().now });
    store.recordStep(K(), step("c:0", { cost: 0, pricing: "priced", final: true }));
    expect(store.cost(K()).measuredUSD).toEqual({ mean: 0, n: 1 });
  });

  it("one unusable step cost keeps the whole attempt out of the USD mean", () => {
    const store = createOutcomeStore({ now: clock().now });
    store.recordStep(K(), step("c:0", { cost: 0.4 }));
    store.recordStep(K(), step("c:0", { cost: Number.NaN, final: true }));
    const c = store.cost(K());
    expect(c.measuredUSD.n).toBe(0);
    expect(c.unpricedAttempts).toBe(1);
    expect(c.tokens.n).toBe(1);
  });

  it("an unpriced model's positive cost is a host measurement and is kept (C6)", () => {
    const store = createOutcomeStore({ now: clock().now });
    store.recordStep(K(), step("c:0", { cost: 0.07, pricing: "unpriced", final: true }));
    expect(store.cost(K()).measuredUSD).toEqual({ mean: 0.07, n: 1 });
  });

  it("negative or non-finite token fields are cleaned to 0", () => {
    const store = createOutcomeStore({ now: clock().now });
    store.recordStep(K(), step("c:0", { tokens: tokens({ input: -5, output: Number.NaN, cacheRead: 7 }), final: true }));
    expect(store.cost(K()).tokens).toEqual({ n: 1, input: 0, output: 0, reasoning: 0, cacheRead: 7, cacheWrite: 0 });
  });

  it("closeAttempt folds an attempt without a final step and leaves finalMessageTokens unchanged", () => {
    const store = createOutcomeStore({ now: clock().now });
    store.recordStep(K(), step("c:0", { final: true, tokens: tokens({ input: 10, output: 77 }) }));
    store.recordStep(K(), step("c:1", { tokens: tokens({ input: 40, output: 5 }) }));
    const revision = store.revision;
    store.closeAttempt("c:1");
    const c = store.cost(K());
    expect(store.revision).toBe(revision + 1);
    expect(c.tokens.n).toBe(2);
    expect(c.tokens.input).toBeCloseTo(25, 12);
    expect(c.finalMessageTokens).toEqual({ mean: 77, n: 1 });
    store.recordStep(K(), step("c:1", { final: true }));
    expect(store.cost(K()).tokens.n).toBe(2);
  });

  it("closeAttempt on an unknown id is a no-op", () => {
    const store = createOutcomeStore({ now: clock().now });
    store.closeAttempt("nope");
    expect(store.revision).toBe(0);
  });

  it("the same attempt id arriving under a different key folds the old accumulator and starts a new one", () => {
    const store = createOutcomeStore({ now: clock().now });
    const a = K("implement", router("medium"));
    const b = K("implement", router("heavy"), "claude-opus-5-5");
    store.recordStep(a, step("c:0", { tokens: tokens({ input: 10 }) }));
    store.recordStep(b, step("c:0", { tokens: tokens({ input: 99 }), final: true }));
    expect(store.cost(a).tokens).toMatchObject({ n: 1, input: 10 });
    expect(store.cost(a).finalMessageTokens.n).toBe(0);
    expect(store.cost(b).tokens).toMatchObject({ n: 1, input: 99 });
  });

  it("maxOpenAttempts folds the oldest open attempt early", () => {
    const store = createOutcomeStore({ now: clock().now, maxOpenAttempts: 2 });
    const k1 = K("c1");
    const k2 = K("c2");
    const k3 = K("c3");
    store.recordStep(k1, step("a1"));
    store.recordStep(k2, step("a2"));
    expect(store.cost(k1).tokens.n).toBe(0);
    store.recordStep(k3, step("a3"));
    expect(store.cost(k1).tokens.n).toBe(1);
    expect(store.cost(k2).tokens.n).toBe(0);
    store.recordStep(k1, step("a1", { final: true })); // a1 is closed: ignored
    expect(store.cost(k1).tokens.n).toBe(1);
  });

  it("a non-final step refreshes the attempt's position in the open order", () => {
    const store = createOutcomeStore({ now: clock().now, maxOpenAttempts: 2 });
    const k1 = K("c1");
    const k2 = K("c2");
    store.recordStep(k1, step("a1"));
    store.recordStep(k2, step("a2"));
    store.recordStep(k1, step("a1")); // a1 is now the newest
    store.recordStep(K("c3"), step("a3")); // evicts a2, not a1
    expect(store.cost(k2).tokens.n).toBe(1);
    expect(store.cost(k1).tokens.n).toBe(0);
  });

  it("sweepAttempts folds only attempts idle for at least maxIdleMs", () => {
    const c = clock();
    const store = createOutcomeStore({ now: c.now });
    store.recordStep(K("old"), step("a1"));
    c.advance(20 * 60_000);
    store.recordStep(K("new"), step("a2"));
    c.advance(15 * 60_000);
    expect(store.sweepAttempts()).toBe(1); // a1 idle 35 min, a2 idle 15 min
    expect(store.cost(K("old")).tokens.n).toBe(1);
    expect(store.cost(K("new")).tokens.n).toBe(0);
    expect(store.sweepAttempts(15 * 60_000)).toBe(1);
    expect(store.cost(K("new")).tokens.n).toBe(1);
    expect(store.sweepAttempts()).toBe(0);
  });

  it("a clock going backwards never sweeps anything", () => {
    const c = clock();
    const store = createOutcomeStore({ now: c.now });
    store.recordStep(K(), step("a1"));
    c.set(T0 - 10 * DAY_MS);
    expect(store.sweepAttempts()).toBe(0);
    expect(store.sweepAttempts(0)).toBe(0);
    expect(store.cost(K()).tokens.n).toBe(0);
  });

  it("cost() of an unknown key is frozen empty statistics", () => {
    const store = createOutcomeStore({ now: clock().now });
    const empty = store.cost(K("nothing"));
    expect(empty).toEqual(emptyCostStats());
    expect(Object.isFrozen(empty)).toBe(true);
    expect(Object.isFrozen(empty.tokens)).toBe(true);
    expect(store.keys()).toEqual([]);
  });

  it("classTokenProfile is the n-weighted token mean over the keys of a class", () => {
    const store = createOutcomeStore({ now: clock().now });
    const a = K("implement", router("medium"), "model-a");
    const b = K("implement", router("heavy"), "model-b");
    const other = K("search", host("explore"), "model-c");
    store.recordStep(a, step("a1", { tokens: tokens({ input: 100, output: 10 }), final: true }));
    for (let i = 0; i < 3; i++) store.recordStep(b, step(`b${i}`, { tokens: tokens({ input: 300, output: 50 }), final: true }));
    store.recordStep(other, step("o1", { tokens: tokens({ input: 9999 }), final: true }));
    const profile = store.classTokenProfile("implement");
    expect(profile).not.toBeNull();
    expect(profile?.n).toBe(4);
    expect(profile?.input).toBeCloseTo(250, 12);
    expect(profile?.output).toBeCloseTo(40, 12);
    expect(store.classTokenProfile("missing")).toBeNull();
    store.recordVerdict(K("verdict-only"), "pass", signal("v1"));
    expect(store.classTokenProfile("verdict-only")).toBeNull();
  });
});

describe("snapshot / fromSnapshot / parseSnapshot", () => {
  function populated() {
    const c = clock();
    const store = createOutcomeStore({ now: c.now });
    const a = K("implement", router("medium"), "claude-sonnet-5-5", "high");
    const b = K("search", host("explore"), "claude-haiku-4-5");
    for (let i = 0; i < 6; i++) store.recordVerdict(a, i % 3 === 0 ? "fail" : "pass", signal(`a${i}`, i === 2 ? "variant" : "dispatch"));
    store.recordFalseRefusal(b, signal("r1"));
    c.advance(3 * DAY_MS);
    store.recordStep(a, step("s1", { cost: 0.31, tokens: tokens({ input: 1200, output: 80, reasoning: 20, cacheRead: 300, cacheWrite: 40 }) }));
    store.recordStep(a, step("s1", { cost: 0.12, tokens: tokens({ input: 900, output: 150 }), final: true }));
    store.recordStep(b, step("s2", { cost: 0, pricing: "unpriced", tokens: tokens({ input: 400, output: 60 }), final: true }));
    return { store, a, b, c };
  }

  it("snapshot() is versioned, sorted, plain-number data and excludes open attempts", () => {
    const { store, a, b } = populated();
    store.recordStep(K("open-only"), step("pending"));
    const snap = store.snapshot();
    expect(snap.version).toBe(1);
    expect(Object.keys(snap.entries)).toEqual([a, b].sort());
    expect(Object.keys(snap.entries)).not.toContain(K("open-only"));
    expect(snap.entries[a]?.counts.variantPass).toBe(1);
    expect(snap.entries[a]?.cost.measuredUSD.n).toBe(1);
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
  });

  it("round trip: fromSnapshot(snapshot()).snapshot() deep-equals the original, also through JSON", () => {
    const { store } = populated();
    const snap = store.snapshot();
    const direct = createOutcomeStore({ now: clock().now });
    expect(direct.fromSnapshot(snap)).toEqual({ accepted: 2, dropped: 0 });
    expect(direct.snapshot()).toEqual(snap);

    const envelope = { schema: OUTCOMES_SCHEMA_ID, version: 1, savedAt: new Date(T0).toISOString(), entries: snap.entries };
    const parsed = parseSnapshot(JSON.parse(JSON.stringify(envelope)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.dropped).toBe(0);
    expect(parsed.snapshot).toEqual(snap);
    const viaJson = createOutcomeStore({ now: clock().now });
    viaJson.fromSnapshot(parsed.snapshot);
    expect(viaJson.snapshot()).toEqual(snap);
  });

  it("fromSnapshot applies neither cap nor decay on load", () => {
    const { store, a } = populated();
    store.configure({ maxEffectiveSamples: 5 });
    const snap = store.snapshot();
    const far = createOutcomeStore({ now: clock(T0 + 1000 * DAY_MS).now });
    far.fromSnapshot(snap);
    expect(far.snapshot()).toEqual(snap);
    expect(far.snapshot().entries[a]?.beta).toEqual(snap.entries[a]?.beta);
  });

  it("the snapshot does not alias internal state", () => {
    const store = createOutcomeStore({ now: clock().now });
    store.recordVerdict(K(), "pass", signal("a"));
    const snap = store.snapshot();
    const entry = snap.entries[K()];
    expect(entry).toBeDefined();
    if (entry) {
      (entry.beta as { alpha: number }).alpha = 999;
      (entry.cost.tokens as { n: number }).n = 999;
    }
    expect(store.snapshot().entries[K()]?.beta.alpha).toBe(1);
    expect(store.cost(K()).tokens.n).toBe(0);
  });

  it("QA-1.3-7: evidence stamped after now is re-stamped at now on load and merge (counts untouched)", () => {
    const writer = createOutcomeStore({ now: clock(T0 + 30 * DAY_MS).now }); // a clock that was a month ahead
    for (let i = 0; i < 3; i++) writer.recordVerdict(K(), "pass", signal(`f${i}`));
    const future = writer.snapshot();
    expect(future.entries[K()]?.beta.updatedAt).toBe(T0 + 30 * DAY_MS);

    const replaced = createOutcomeStore({ now: clock().now });
    replaced.fromSnapshot(future);
    expect(replaced.snapshot().entries[K()]?.beta).toEqual({ alpha: 3, beta: 0, updatedAt: T0 });

    const merged = createOutcomeStore({ now: clock().now });
    merged.recordVerdict(K(), "pass", signal("live"));
    merged.fromSnapshot(future, { mode: "merge" });
    expect(merged.snapshot().entries[K()]?.beta).toEqual({ alpha: 4, beta: 0, updatedAt: T0 });
    // a key that is not live yet is taken as is, also re-stamped
    const fresh = createOutcomeStore({ now: clock().now });
    fresh.fromSnapshot(future, { mode: "merge" });
    expect(fresh.snapshot().entries[K()]?.beta.updatedAt).toBe(T0);
  });

  it("QA-1.3-7: a non-finite clock reading means Date.now() everywhere in the store", () => {
    const store = createOutcomeStore({ now: () => Number.NaN });
    const before = Date.now();
    store.recordVerdict(K(), "pass", signal("a"));
    store.recordStep(K(), step("s", { final: true }));
    const updatedAt = store.snapshot().entries[K()]?.beta.updatedAt ?? Number.NaN;
    expect(updatedAt).toBeGreaterThanOrEqual(before);
    expect(updatedAt).toBeLessThanOrEqual(Date.now());
    expect(Number.isFinite(store.posterior(K()).mean)).toBe(true);
    expect(store.sweepAttempts()).toBe(0);
    const infinite = createOutcomeStore({ now: () => Number.POSITIVE_INFINITY });
    infinite.recordVerdict(K(), "fail", signal("b"));
    expect(Number.isFinite(infinite.snapshot().entries[K()]?.beta.updatedAt ?? Number.NaN)).toBe(true);
  });

  it("replace (default) swaps the persisted state, keeps open attempts, and bumps the revision", () => {
    const { store, a } = populated();
    store.recordStep(a, step("still-open", { tokens: tokens({ input: 5 }) }));
    const empty: OutcomeSnapshot = { version: 1, entries: {} };
    const revision = store.revision;
    expect(store.fromSnapshot(empty)).toEqual({ accepted: 0, dropped: 0 });
    expect(store.keys()).toEqual([]);
    expect(store.revision).toBe(revision + 1);
    store.recordStep(a, step("still-open", { final: true, tokens: tokens({ input: 7 }) }));
    expect(store.cost(a).tokens).toMatchObject({ n: 1, input: 12 });
    const again = store.revision;
    expect(createOutcomeStore().fromSnapshot(empty)).toEqual({ accepted: 0, dropped: 0 });
    expect(store.revision).toBe(again);
  });

  it("merge adds disk evidence to in-memory evidence (records made before the load are not lost)", () => {
    const disk = createOutcomeStore({ now: clock().now });
    for (let i = 0; i < 3; i++) disk.recordVerdict(K(), "pass", signal(`d${i}`));
    disk.recordStep(K(), step("ds", { cost: 0.5, final: true, tokens: tokens({ input: 100 }) }));
    const live = createOutcomeStore({ now: clock().now });
    live.recordVerdict(K(), "fail", signal("l1"));
    live.recordStep(K(), step("ls", { cost: 0.1, final: true, tokens: tokens({ input: 300 }) }));
    live.recordVerdict(K("live-only"), "pass", signal("l2"));
    const revision = live.revision;

    expect(live.fromSnapshot(disk.snapshot(), { mode: "merge" })).toEqual({ accepted: 1, dropped: 0 });
    expect(live.revision).toBe(revision + 1);
    expect(live.keys()).toEqual([K(), K("live-only")].sort());
    const entry = live.snapshot().entries[K()];
    expect(entry?.counts).toMatchObject({ pass: 3, fail: 1 });
    expect(entry?.beta.alpha).toBeCloseTo(3, 12);
    expect(entry?.beta.beta).toBeCloseTo(1, 12);
    expect(entry?.cost.measuredUSD.n).toBe(2);
    expect(entry?.cost.measuredUSD.mean).toBeCloseTo(0.3, 12);
    expect(entry?.cost.tokens.input).toBeCloseTo(200, 12);
  });

  it("merge decays older disk evidence to the common instant", () => {
    const diskClock = clock(T0 - 14 * DAY_MS);
    const disk = createOutcomeStore({ now: diskClock.now });
    for (let i = 0; i < 4; i++) disk.recordVerdict(K(), "pass", signal(`d${i}`));
    const live = createOutcomeStore({ now: clock().now });
    live.fromSnapshot(disk.snapshot(), { mode: "merge" });
    expect(live.snapshot().entries[K()]?.beta).toEqual(disk.snapshot().entries[K()]?.beta); // no live entry: taken as is
    live.recordVerdict(K(), "pass", signal("l1"));
    expect(live.snapshot().entries[K()]?.beta.alpha).toBeCloseTo(4 * 0.5 + 1, 12);
  });

  it("invalid entries are dropped and counted, valid ones kept", () => {
    const { store, a } = populated();
    const good = store.snapshot().entries[a];
    const bad = {
      version: 1,
      entries: {
        [a]: good,
        "not a key": good,
        [K("neg")]: { ...good, beta: { alpha: -1, beta: 0, updatedAt: T0 } },
        [K("frac")]: { ...good, counts: { ...good?.counts, pass: 1.5 } },
        [K("nan-clock")]: { ...good, beta: { alpha: 1, beta: 1, updatedAt: "yesterday" } },
        [K("null")]: null,
      },
    } as unknown as OutcomeSnapshot;
    const target = createOutcomeStore({ now: clock().now });
    expect(target.fromSnapshot(bad)).toEqual({ accepted: 1, dropped: 5 });
    expect(target.keys()).toEqual([a]);
  });

  describe("parseSnapshot", () => {
    const entry = () => createOutcomeStore({ now: clock().now }).snapshot();
    const envelope = (patch: Record<string, unknown> = {}) => ({
      schema: OUTCOMES_SCHEMA_ID,
      version: 1,
      savedAt: "2026-10-06T12:00:00.000Z",
      entries: entry().entries,
      ...patch,
    });

    it("accepts a valid envelope, including an empty one", () => {
      expect(parseSnapshot(envelope())).toEqual({ ok: true, snapshot: { version: 1, entries: {} }, dropped: 0 });
    });

    it.each([
      ["null", null],
      ["an array", []],
      ["a string", "x"],
      ["a wrong schema", envelope({ schema: "other" })],
      ["a missing schema", envelope({ schema: undefined })],
      ["a missing version", envelope({ version: undefined })],
      ["a string version", envelope({ version: "1" })],
      ["a fractional version", envelope({ version: 1.5 })],
      ["version 0", envelope({ version: 0 })],
      ["a negative version", envelope({ version: -1 })],
      ["missing entries", envelope({ entries: undefined })],
      ["array entries", envelope({ entries: [] })],
    ])("%s is corrupt", (_name, json) => {
      const r = parseSnapshot(json);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe("corrupt");
        expect(r.message.length).toBeGreaterThan(0);
      }
    });

    it("a newer version is unsupported-version, whatever its entries look like", () => {
      const r = parseSnapshot(envelope({ version: 2, entries: "different shape" }));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe("unsupported-version");
        expect(r.message).toContain("2");
      }
    });

    it("reports dropped entries and returns the rest sorted", () => {
      const store = createOutcomeStore({ now: clock().now });
      store.recordVerdict(K("b"), "pass", signal("1"));
      store.recordVerdict(K("A"), "pass", signal("2"));
      const entries = { ...store.snapshot().entries, "bad key": {}, [K("zzz")]: { beta: {}, counts: {}, cost: {} } };
      const r = parseSnapshot(envelope({ entries }));
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.dropped).toBe(2);
        expect(Object.keys(r.snapshot.entries)).toEqual([K("A"), K("b")]);
      }
    });

    it("rejects negative means, fractional n and missing cost fields", () => {
      const store = createOutcomeStore({ now: clock().now });
      store.recordStep(K(), step("s", { final: true }));
      const good = store.snapshot().entries[K()];
      const variants = [
        { ...good, cost: { ...good?.cost, measuredUSD: { mean: -1, n: 1 } } },
        { ...good, cost: { ...good?.cost, tokens: { ...good?.cost.tokens, n: 0.5 } } },
        { ...good, cost: { ...good?.cost, steps: undefined } },
        { ...good, cost: { ...good?.cost, unpricedAttempts: -1 } },
        { ...good, cost: { ...good?.cost, tokens: { ...good?.cost.tokens, input: -2 } } },
        { ...good, counts: undefined },
      ];
      for (const [i, v] of variants.entries()) {
        const r = parseSnapshot(envelope({ entries: { [K()]: v } }));
        expect(r.ok && r.dropped, `variant ${i}`).toBe(1);
      }
      const ok = parseSnapshot(envelope({ entries: { [K()]: good } }));
      expect(ok.ok && ok.dropped).toBe(0);
    });
  });
});

describe("performance", () => {
  it("10 000 mixed records over 50 keys stay under 50 ms", () => {
    const c = clock();
    const store = createOutcomeStore({ now: c.now });
    const keys = Array.from({ length: 50 }, (_, i) => K(`class${i % 5}`, i % 2 === 0 ? router(`agent${i}`) : host(`agent${i}`), `model-${i}`));
    for (let i = 0; i < 400; i++) {
      store.recordVerdict(keys[i % 50] as OutcomeKey, i % 3 === 0 ? "fail" : "pass", signal(`warm-v${i}`));
      store.recordStep(keys[i % 50] as OutcomeKey, step(`warm-s${i}`, { final: true }));
    }
    const start = performance.now();
    for (let i = 0; i < 5000; i++) {
      const key = keys[i % 50] as OutcomeKey;
      store.recordVerdict(key, i % 4 === 0 ? "fail" : "pass", signal(`v${i}`, i % 7 === 0 ? "variant" : "dispatch"));
      store.recordStep(key, step(`s${i}`, { final: true }));
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);
    expect(store.keys()).toHaveLength(50);
  });
});

describe("prior is never stored", () => {
  it("a rank change never rewrites evidence: only the read differs", () => {
    const store = createOutcomeStore({ now: clock().now });
    store.recordVerdict(K(), "pass", signal("a"));
    const snapshot = JSON.stringify(store.snapshot());
    const low = store.posterior(K(), priorForRankOffset(-2));
    const high = store.posterior(K(), priorForRankOffset(3));
    expect(low.mean).toBeLessThan(high.mean);
    expect(JSON.stringify(store.snapshot())).toBe(snapshot);
    expect(store.posterior(K(), SAME_RANK_PRIOR).n).toBe(1);
  });
});
