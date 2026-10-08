import { describe, expect, it } from "vitest";
import { decideRole, explorationRate, MAX_EXPLORATION_RATE } from "../../src/routing/engine/kernel";
import { buildRoleLadder, escalateLadder, roleEscalatePolicy, roleTierOrder, type RoleLadderInput } from "../../src/routing/engine/ladders";
import type {
  Candidate,
  EngineStoreView,
  KernelRouting,
  RoleDecisionInput,
  RoleLadder,
  RoleWindow,
} from "../../src/routing/engine/types";
import {
  advance,
  newLadderState,
  nextAction,
  recordAttempt,
  type EscalatePolicy,
  type LadderVerdict,
} from "../../src/escalate/ladder";
import type { RouterConfig, TierConfig } from "../../src/router/config";
import type { AuthorityAction, RoleKind, RoleSpec } from "../../src/router/roles";
import {
  CLASS_STATIC_TIER,
  type Detection,
  type Risk,
  type Scope,
  type TaskClass,
  type TaskFacts,
} from "../../src/routing/classify/types";
import { emptyCostStats } from "../../src/routing/outcomes/cost";
import { makeKey, type OutcomeKey } from "../../src/routing/outcomes/types";
import {
  authorityFloor,
  effectiveDetection,
  effectiveFacts,
  effectiveFactsOf,
  tierBounds as tierBoundsOf,
  type ClassifiedDispatch,
  type DispatchGrant,
  type TierBoundsOptions,
} from "../../src/routing/roles/policy";
import type { RouteLine } from "../../src/routing/classify/types";

/** `tierBounds` on a classify shape built from plain facts (and an optional route line), with an effective detection. */
function tierBounds(spec: RoleSpec, grant: DispatchGrant, f: TaskFacts, d: Detection, o: TierBoundsOptions & { routeLine?: Partial<RouteLine> | null }) {
  const routeLine = o.routeLine ? ({ pin: false, ignored: [], ...o.routeLine } as RouteLine) : null;
  return tierBoundsOf(spec, grant, classifiedOf(f, routeLine), eff(d), o);
}

/** QA-P12-2-1: a plain depth as the A34 inputs that yield it (deterministic = the router's own gate runs the checks). */
function eff(d: Detection) {
  return effectiveDetection(d === "deterministic"
    ? { routerGate: true, claim: null, acceptance: null }
    : { routerGate: false, claim: d, acceptance: d });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HAIKU = "anthropic/claude-haiku-5-5";
const SONNET = "anthropic/claude-sonnet-5-5";
const OPUS = "anthropic/claude-opus-5-5";
const ORDER = ["fast", "medium", "heavy"] as const;
const TIERS: Record<string, TierConfig> = {
  fast: { model: HAIKU, costRatio: 1 },
  medium: { model: SONNET, variant: "medium", costRatio: 5 },
  heavy: { model: OPUS, variant: "xhigh", costRatio: 20 },
};
const GENEROUS = { maxAttemptsPerTier: 2, maxTotalAttempts: 6, costCeiling: { multiple: 1000 } };

function cfgOf(tiers: Record<string, TierConfig> = TIERS, escalate?: Record<string, unknown>): RouterConfig {
  return {
    activePreset: "p",
    presets: { p: tiers },
    rules: [],
    defaultTier: "medium",
    ...(escalate === undefined ? {} : { enforcement: { escalate } as unknown as RouterConfig["enforcement"] }),
  };
}
const CFG = cfgOf();

const ROUTING: KernelRouting = {
  profile: "balanced",
  margin: 0.2,
  minClassConfidence: 0.7,
  detection: { deterministic: 0.95, grader: 0.7, none: 0.3 },
};

const CLASSES = Object.keys(CLASS_STATIC_TIER) as TaskClass[];

function facts(over: Partial<TaskFacts> = {}): TaskFacts {
  return { class: "implement", risk: "low", scope: "single", needs: [], confidence: 0.9, source: "rules", ...over };
}

function win(floor: string, ceiling: string, pinned: string | null = null): RoleWindow {
  return { floor, ceiling, pinned };
}

function ladderFor(cls: TaskClass, window: RoleWindow, over: Partial<RoleLadderInput> = {}): RoleLadder {
  return buildRoleLadder({ cfg: CFG, facts: { class: cls, needs: [] }, role: "implementer", window, ...over });
}

function roleKey(cls: string, model: string, variant: string | null, agent = "implementer"): OutcomeKey {
  const slash = model.indexOf("/");
  return makeKey(cls, { origin: "role", id: agent }, model.slice(0, slash), model.slice(slash + 1), variant);
}

function keyOfCandidate(cls: string, c: Candidate): OutcomeKey {
  return roleKey(cls, c.model, c.variant, c.agent.id);
}

/** Posterior mean / effective evidence per key; absent → the prior's mean and no evidence. */
function storeOf(spec: { p?: Record<string, number>; n?: Record<string, number> } = {}): EngineStoreView {
  return {
    posterior(key, prior) {
      const pr = prior ?? { alpha: 4, beta: 1 };
      return { alpha: pr.alpha, beta: pr.beta, mean: spec.p?.[key] ?? pr.alpha / (pr.alpha + pr.beta), n: spec.n?.[key] ?? 0, prior: pr };
    },
    cost: () => emptyCostStats(),
    classTokenProfile: () => null,
  };
}

/** The classify shape of a dispatch whose rules facts are `f` (no route line unless given). */
function classifiedOf(f: TaskFacts, routeLine: RouteLine | null = null): ClassifiedDispatch {
  return { facts: f, trace: { rules: f, routeLine } };
}

/** Test overrides: `facts` and a plain `detection` are wrapped into the classify shape and the effective brand. */
type InputOver = Omit<Partial<RoleDecisionInput>, "detection"> & { facts?: TaskFacts; detection?: Detection };

function input(ladder: RoleLadder, over: InputOver = {}): RoleDecisionInput {
  const { facts: f, detection, ...rest } = over;
  return {
    classified: classifiedOf(f ?? facts()),
    ladder,
    detection: eff(detection ?? "deterministic"),
    engine: "enforce",
    routing: ROUTING,
    store: null,
    ...rest,
  };
}

function role(agent: string, kind: RoleKind, allow: readonly AuthorityAction[], floor: string, ceiling: string): RoleSpec {
  return {
    agent,
    kind,
    description: agent,
    prompt: "",
    authority: { mode: "fixed", allow, deny: [] },
    tierRange: { floor, ceiling },
    assurance: "none",
    guard: "reader",
    budget: {},
    enabled: true,
  };
}

function grantOf(...actions: AuthorityAction[]): DispatchGrant {
  return { actions: new Set(actions), notes: [], workRoot: "D:\\git\\omr-rta-p12" };
}

const LOCAL: readonly AuthorityAction[] = ["read", "glob", "grep", "router_git"];
const EXPLORER = role("explorer", "explore", LOCAL, "fast", "medium");
const IMPLEMENTER = role("implementer", "implement", [...LOCAL, "edit", "router_run"], "fast", "heavy");

/** Seeded generator (mulberry32): reproducible property inputs without a new dependency. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function oneOf<T>(next: () => number, values: readonly T[]): T {
  return values[Math.min(values.length - 1, Math.floor(next() * values.length))]!;
}

const rankOf = (tier: string): number => (ORDER as readonly string[]).indexOf(tier);

// ---------------------------------------------------------------------------
// T1.2.3 — role ladders
// ---------------------------------------------------------------------------

describe("role ladders per class (T1.2.3)", () => {
  it.each(CLASSES)("%s: the window's rungs, run by the role agent; the default is the class tier", (cls) => {
    const ladder = ladderFor(cls, win("fast", "heavy"));
    expect(ladder.candidates.map((c) => c.tier)).toEqual(["fast", "medium", "heavy"]);
    for (const c of ladder.candidates) {
      expect(c.agent).toEqual({ origin: "role", id: "implementer" });
      expect(c.source).toBe("role-range");
      expect(c.rank).toBe(rankOf(c.tier));
    }
    const expected = CLASS_STATIC_TIER[cls] ?? "fast";
    expect(ladder.candidates[ladder.staticDefault!]!.tier).toBe(expected);
    expect(ladder.pinnedIndex).toBeNull();
    const d = decideRole(input(ladder, { facts: facts({ class: cls }) }));
    expect(d.dispatch?.tier).toBe(expected);
    expect(d.base).toBe(d.dispatch);
    expect(d.decision.chosen.key.startsWith(`${cls}|role:implementer|`)).toBe(true);
    if (CLASS_STATIC_TIER[cls] === null) expect(ladder.reasons).toContain("default:no-class-tier");
  });

  it("outcome keys are class|role:<agent>|provider/model#variant", () => {
    const ladder = ladderFor("implement", win("fast", "heavy"));
    const d = decideRole(input(ladder));
    expect(d.decision.chosen.key).toBe("implement|role:implementer|anthropic/claude-sonnet-5-5#medium");
    expect(d.decision.chosen.origin).toBe("role");
    expect(Object.keys(d.decision.costs).sort()).toEqual([
      "implement|role:implementer|anthropic/claude-haiku-5-5#default",
      "implement|role:implementer|anthropic/claude-opus-5-5#xhigh",
      "implement|role:implementer|anthropic/claude-sonnet-5-5#medium",
    ]);
  });

  it("the class tier is clamped into the window", () => {
    const design = ladderFor("design", win("fast", "medium"));
    expect(design.candidates.map((c) => c.tier)).toEqual(["fast", "medium"]);
    expect(design.candidates[design.staticDefault!]!.tier).toBe("medium");
    expect(design.reasons).toContain("default:clamp:ceiling");
    const search = ladderFor("search", win("heavy", "heavy"));
    expect(search.candidates.map((c) => c.tier)).toEqual(["heavy"]);
    expect(search.candidates[search.staticDefault!]!.tier).toBe("heavy");
    expect(search.reasons).toContain("default:clamp:floor");
    const off = ladderFor("implement", win("medium", "heavy"), { classTier: "turbo" });
    expect(off.candidates[off.staticDefault!]!.tier).toBe("medium");
    expect(off.reasons).toContain("default:off-ladder:turbo");
    expect(off.classRank).toBeNull();
    const explicit = ladderFor("search", win("fast", "heavy"), { classTier: "heavy" });
    expect(explicit.candidates[explicit.staticDefault!]!.tier).toBe("heavy");
  });

  it("fails closed on a window it cannot place", () => {
    const none = ladderFor("implement", win("turbo", "heavy"));
    expect(none.candidates).toEqual([]);
    expect(none.reasons).toEqual(["window:floor-off-ladder:turbo", "window:no-candidates"]);
    const d = decideRole(input(none, { exploration: { rate: 0.2, decisionID: "x" } }));
    expect(d.dispatch).toBeNull();
    expect(d.base).toBeNull();
    expect(d.decision.reasonCode).toBe("kept:no-candidates");
    expect(d.propensity).toBe(1);
    const offCeiling = ladderFor("design", win("medium", "turbo"));
    expect(offCeiling.candidates.map((c) => c.tier)).toEqual(["medium"]);
    expect(offCeiling.reasons).toContain("window:ceiling-off-ladder:turbo");
    const reversed = ladderFor("design", win("medium", "fast"));
    expect(reversed.candidates.map((c) => c.tier)).toEqual(["medium"]);
    expect(reversed.reasons).toContain("window:ceiling-below-floor");
  });

  it("a model#variant listed on two tiers is one key, kept on the lower tier", () => {
    const cfg = cfgOf({ ...TIERS, heavy: { model: SONNET, variant: "medium", costRatio: 20 } }, GENEROUS);
    const ladder = buildRoleLadder({ cfg, facts: { class: "design", needs: [] }, role: "architect", window: win("medium", "heavy") });
    expect(ladder.candidates.map((c) => c.tier)).toEqual(["medium"]);
    expect(ladder.excluded).toEqual([{ agent: { origin: "role", id: "architect" }, model: SONNET, variant: "medium", why: "duplicate" }]);
    expect(ladder.tiers).toEqual([{ tier: "medium", rank: 1, first: 0 }, { tier: "heavy", rank: 2, first: null }]);
    // the class tier (heavy) has no rung of its own: the default falls back to the highest tier that has one
    expect(ladder.candidates[ladder.staticDefault!]!.tier).toBe("medium");
    // the runner's heavy attempt is a reachable rung, never a candidate
    expect(ladder.reachable?.map((c) => c.tier)).toEqual(["heavy"]);
    const pinned = buildRoleLadder({ cfg, facts: { class: "design", needs: [] }, role: "architect", window: win("medium", "heavy", "heavy") });
    expect(pinned.candidates[pinned.pinnedIndex!]!.tier).toBe("medium");
    expect(pinned.reasons).toContain("pinned:heavy->medium"); // QA-P12-1-8: the requested tier had no rung of its own
  });

  it("a needs-carrying dispatch keeps every rung eligible (one agent, one grant)", () => {
    const ladder = buildRoleLadder({ cfg: CFG, facts: { class: "implement", needs: ["edit", "shell"] }, role: "implementer", window: win("fast", "heavy") });
    for (const c of ladder.candidates) expect(c.grants).toEqual(["edit", "shell"]);
    const fast = keyOfCandidate("implement", ladder.candidates[0]!);
    const d = decideRole(input(ladder, { facts: facts({ needs: ["edit", "shell"] }), store: storeOf({ p: { [fast]: 0.99 }, n: { [fast]: 40 } }) }));
    expect(d.decision.ineligible[fast]).toBeUndefined();
    expect(d.dispatch?.tier).toBe("fast");
  });

  it("pricing lookups are applied and a throwing lookup prices as unpriced", () => {
    const warnings: string[] = [];
    const priced = ladderFor("implement", win("fast", "medium"), {
      pricing: (model) => {
        if (model === HAIKU) throw new Error("boom");
        return [{ input: 3, output: 15 }];
      },
      logger: { warn: (m) => warnings.push(m) },
    });
    expect(priced.candidates[0]!.pricing).toBeUndefined();
    expect(priced.candidates[1]!.pricing).toEqual([{ input: 3, output: 15 }]);
    expect(warnings.some((w) => w.includes(HAIKU))).toBe(true);
  });
});

describe("role kernel decisions (T1.2.3): A27 and A34 as in tier mode", () => {
  const ladder = ladderFor("implement", win("fast", "heavy"));
  const fast = roleKey("implement", HAIKU, null);
  const medium = roleKey("implement", SONNET, "medium");

  it("enforce applies an evidenced switch below the default; other engines only log it", () => {
    const store = storeOf({ p: { [fast]: 0.99, [medium]: 0.5 }, n: { [fast]: 40, [medium]: 40 } });
    const enforced = decideRole(input(ladder, { store }));
    expect(enforced.decision.reasonCode).toBe("switched");
    expect(enforced.switched).toBe(true);
    expect(enforced.dispatch?.tier).toBe("fast");
    expect(enforced.base?.tier).toBe("medium");
    const logged = decideRole(input(ladder, { store, engine: "static" }));
    expect(logged.decision.switched).toBe(true);
    expect(logged.switched).toBe(false);
    expect(logged.dispatch?.tier).toBe("medium");
  });

  it("A27: no evidence on the cheaper role key → kept:evidence", () => {
    const d = decideRole(input(ladder, { store: storeOf({ p: { [fast]: 0.99, [medium]: 0.5 } }) }));
    expect(d.decision.reasonCode).toBe("kept:evidence");
    expect(d.dispatch?.tier).toBe("medium");
  });

  it("A34: high risk without detection never moves down, even with evidence", () => {
    const store = storeOf({ p: { [fast]: 0.99, [medium]: 0.5 }, n: { [fast]: 40, [medium]: 40 } });
    const d = decideRole(input(ladder, { store, facts: facts({ risk: "high" }), detection: "none" }));
    expect(d.decision.ineligible[fast]).toBe("never-down");
    expect(d.switched).toBe(false);
    expect(d.dispatch?.tier).toBe("medium");
  });

  it("passes the orchestrator and remainingTurns through to the kernel", () => {
    const d = decideRole(input(ladder, { orchestrator: { pricing: [{ input: 3, output: 15 }], contextTokens: 1000 }, remainingTurns: 2 }));
    expect(d.dispatch?.tier).toBe("medium");
  });
});

describe("pin (route-line tier=)", () => {
  const fast = roleKey("implement", HAIKU, null);
  const store = storeOf({ p: { [fast]: 0.99 }, n: { [fast]: 40 } });

  it("a pinned tier is dispatched as is, never switched or explored", () => {
    const ladder = ladderFor("implement", win("fast", "heavy", "heavy"));
    expect(ladder.reasons).toContain("pinned:heavy");
    const d = decideRole(input(ladder, { store, exploration: { rate: 0.2, decisionID: "pin" } }));
    expect(d.decision.pinned).toBe(true);
    expect(d.decision.reasonCode).toBe("kept:pinned");
    expect(d.dispatch?.tier).toBe("heavy");
    expect(d.switched).toBe(false);
    expect(d.explore).toBe(false);
    expect(d.propensity).toBe(1);
  });

  it("a pin below the authority floor is lifted by tierBounds; the ladder honours the lifted pin", () => {
    const bounds = tierBounds(IMPLEMENTER, grantOf(...LOCAL, "edit", "router_run"), facts(), "none", {
      floorTier: null, runningTier: null, pinTier: "fast", tiers: escalateLadder(CFG),
    });
    expect(bounds).toMatchObject({ floor: "heavy", pinned: "heavy" });
    const d = decideRole(input(ladderFor("implement", bounds), { detection: "none" }));
    expect(d.dispatch?.tier).toBe("heavy");
  });

  it("re-clamps a pin outside the window and ignores one off the ladder", () => {
    const clamped = ladderFor("implement", win("fast", "medium", "heavy"));
    expect(clamped.reasons).toEqual(expect.arrayContaining(["pin:clamp", "pinned:heavy->medium"]));
    expect(clamped.reasons).not.toContain("pinned:medium");
    expect(clamped.candidates[clamped.pinnedIndex!]!.tier).toBe("medium");
    const off = ladderFor("implement", win("fast", "heavy", "turbo"));
    expect(off.pinnedIndex).toBeNull();
    expect(off.reasons).toContain("pin:off-ladder:turbo");
  });
});

describe("resume", () => {
  const fast = roleKey("search", HAIKU, null);
  const store = storeOf({ p: { [fast]: 0.99 }, n: { [fast]: 40 } });

  it("at a higher running rung with a fast default: dispatched on the running rung, never switched down", () => {
    const ladder = ladderFor("search", win("fast", "heavy"));
    expect(ladder.candidates[ladder.staticDefault!]!.tier).toBe("fast");
    const d = decideRole(input(ladder, { facts: facts({ class: "search" }), store, resume: { model: OPUS, variant: "xhigh" } }));
    expect(d.base?.tier).toBe("heavy");
    expect(d.reasons).toContain("resume:running");
    expect(d.decision.switched).toBe(true);
    expect(d.reasons).toContain("kept:resume");
    expect(d.switched).toBe(false);
    expect(d.dispatch?.tier).toBe("heavy");
  });

  it("tierBounds' running rung raises the window floor: the default clamps to it", () => {
    const bounds = tierBounds(EXPLORER, grantOf(...LOCAL), facts({ class: "search" }), "none", {
      floorTier: null, runningTier: "heavy", pinTier: null, tiers: escalateLadder(CFG),
    });
    expect(bounds).toMatchObject({ floor: "heavy", ceiling: "heavy" });
    const d = decideRole(input(ladderFor("search", bounds), { facts: facts({ class: "search" }), resume: { model: OPUS, variant: "xhigh" } }));
    expect(d.dispatch?.tier).toBe("heavy");
  });

  it("a running rung below the default leaves the base alone; an unknown running model lifts it (QA-P12-1-3)", () => {
    const ladder = ladderFor("implement", win("fast", "heavy"));
    const lower = decideRole(input(ladder, { resume: { model: HAIKU, variant: null } }));
    expect(lower.base?.tier).toBe("medium");
    expect(lower.reasons).not.toContain("resume:running");
    const off = decideRole(input(ladder, { resume: { model: "openai/gpt-9", variant: null } }));
    expect(off.base?.tier).toBe("heavy");
    expect(off.reasons).toContain("resume:off-ladder:lift");
  });
});

describe("floorTier above the role ceiling", () => {
  it("the floor wins: the window is widened upward only and the dispatch is on the floor", () => {
    const bounds = tierBounds(EXPLORER, grantOf(...LOCAL), facts({ class: "search" }), "none", {
      floorTier: "heavy", runningTier: null, pinTier: null, tiers: escalateLadder(CFG),
    });
    expect(bounds).toMatchObject({ floor: "heavy", ceiling: "heavy" });
    const ladder = ladderFor("search", bounds);
    expect(ladder.candidates.map((c) => c.tier)).toEqual(["heavy"]);
    expect(decideRole(input(ladder, { facts: facts({ class: "search" }) })).dispatch?.tier).toBe("heavy");
  });
});

// ---------------------------------------------------------------------------
// T1.2.4 — exploration
// ---------------------------------------------------------------------------

describe("exploration (T1.2.4)", () => {
  const implement = ladderFor("implement", win("fast", "heavy"));
  const ids = Array.from({ length: 200 }, (_, i) => `decision-${i}`);

  it("clamps the rate to [0, 0.2]; anything unusable is off", () => {
    expect(MAX_EXPLORATION_RATE).toBe(0.2);
    expect(explorationRate(0.1)).toBe(0.1);
    expect(explorationRate(0.5)).toBe(0.2);
    expect(explorationRate(0)).toBe(0);
    expect(explorationRate(-1)).toBe(0);
    expect(explorationRate(Number.NaN)).toBe(0);
    expect(explorationRate("0.1")).toBe(0);
  });

  it("explores only to a rung at or above the floor and below the static default; propensity = P(dispatch)", () => {
    const draws = ids.map((decisionID) => decideRole(input(implement, { exploration: { rate: 0.2, decisionID } })));
    const explored = draws.filter((d) => d.explore);
    expect(explored.length).toBeGreaterThan(10);
    expect(explored.length).toBeLessThan(80);
    for (const d of explored) {
      expect(d.dispatch?.tier).toBe("fast");
      expect(d.reasons).toContain("explore");
      expect(d.switched).toBe(false);
      expect(d.propensity).toBeCloseTo(0.2, 10);
    }
    for (const d of draws.filter((x) => !x.explore)) {
      expect(d.dispatch?.tier).toBe("medium");
      expect(d.propensity).toBeCloseTo(0.8, 10);
    }
  });

  it("splits the rate over several targets, never above the default nor below the floor", () => {
    const design = ladderFor("design", win("fast", "heavy"));
    const draws = ids.map((decisionID) => decideRole(input(design, { facts: facts({ class: "design" }), exploration: { rate: 0.2, decisionID } })));
    const tiers = new Set(draws.filter((d) => d.explore).map((d) => d.dispatch?.tier));
    expect([...tiers].sort()).toEqual(["fast", "medium"]);
    for (const d of draws) {
      if (d.explore) expect(d.propensity).toBeCloseTo(0.1, 10);
      expect(d.propensity).toBeGreaterThan(0);
      expect(d.propensity).toBeLessThanOrEqual(1);
    }
    const floored = ladderFor("design", win("medium", "heavy"));
    for (const decisionID of ids) {
      const d = decideRole(input(floored, { facts: facts({ class: "design" }), exploration: { rate: 0.2, decisionID } }));
      if (d.explore) expect(d.dispatch?.tier).toBe("medium");
    }
  });

  it("is deterministic per decisionID", () => {
    for (const decisionID of ids.slice(0, 50)) {
      const a = decideRole(input(implement, { exploration: { rate: 0.2, decisionID } }));
      const b = decideRole(input(implement, { exploration: { rate: 0.2, decisionID } }));
      expect([b.explore, b.dispatch, b.propensity]).toEqual([a.explore, a.dispatch, a.propensity]);
    }
  });

  it("an exploit that is itself a target keeps propensity 1", () => {
    const fast = roleKey("implement", HAIKU, null);
    const store = storeOf({ p: { [fast]: 0.99 }, n: { [fast]: 40 } });
    for (const decisionID of ids.slice(0, 40)) {
      const d = decideRole(input(implement, { store, exploration: { rate: 0.2, decisionID } }));
      expect(d.dispatch?.tier).toBe("fast");
      expect(d.propensity).toBeCloseTo(1, 10);
    }
  });

  const off: Array<[string, InputOver, RoleLadder?]> = [
    ["rate 0", { exploration: { rate: 0, decisionID: "" } }],
    ["no exploration config", { exploration: null }],
    ["a non-enforce engine", { engine: "static" }],
    ["high risk", { facts: facts({ risk: "high" }) }],
    ["detection none", { detection: "none" }],
    ["detection grader", { detection: "grader" }],
    ["a resume", { resume: { model: SONNET, variant: "medium" } }],
    ["a pin", {}, ladderFor("implement", win("fast", "heavy", "medium"))],
    ["a default on the floor", { facts: facts({ class: "search" }) }, ladderFor("search", win("fast", "heavy"))],
  ];
  it.each(off)("never with %s", (_name, over, ladder) => {
    for (const decisionID of ids) {
      const exploration = "exploration" in over
        ? (over.exploration ? { ...over.exploration, decisionID } : null)
        : { rate: 0.2, decisionID };
      const d = decideRole(input(ladder ?? implement, { ...over, exploration }));
      expect(d.explore).toBe(false);
      expect(d.propensity).toBe(1);
      expect(d.reasons).not.toContain("explore");
    }
  });
});

// ---------------------------------------------------------------------------
// simulate == runner on role ladders
// ---------------------------------------------------------------------------

const FAIL: LadderVerdict = { pass: false, outcome: "fail", reasons: [] };

/** The runner loop with a failing verdict after every attempt, written against `escalate/ladder` directly. */
function runnerTrace(policy: EscalatePolicy, tiers: Record<string, TierConfig>, start: Candidate): { trace: string[]; cost: number } {
  let state = newLadderState(start.tier, policy);
  let current = { tier: start.tier, model: start.model, variant: start.variant, costRatio: start.costRatio };
  const trace: string[] = [];
  for (let i = 0; i < 64; i++) {
    trace.push(`${current.tier}:${current.model}#${current.variant ?? "default"}`);
    state = recordAttempt(state, current.costRatio);
    const action = nextAction(state, FAIL, policy);
    if (action.action !== "retry" && action.action !== "escalate") break;
    state = advance(state, action);
    const tier = tiers[state.currentTier]!;
    current = action.action === "retry"
      ? { ...current, costRatio: action.costRatio ?? tier.costRatio ?? 1 }
      : { tier: state.currentTier, model: tier.model, variant: tier.variant ?? null, costRatio: action.costRatio ?? tier.costRatio ?? 1 };
  }
  return { trace, cost: state.cumulativeCost };
}

describe("simulate == runner on role ladders", () => {
  const cfg = cfgOf(TIERS, GENEROUS);
  const windows: RoleWindow[] = [win("fast", "heavy"), win("fast", "medium"), win("medium", "heavy"), win("heavy", "heavy")];

  it.each(windows.map((w) => [`${w.floor}-${w.ceiling}`, w] as const))("%s: every rung's priced path is the runner's", (_name, window) => {
    const ladder = buildRoleLadder({ cfg, facts: { class: "implement", needs: [] }, role: "implementer", window });
    const policy = roleEscalatePolicy(cfg, window)!;
    expect(policy.ladder).toEqual(ORDER.slice(rankOf(window.floor), rankOf(window.ceiling) + 1));
    expect(policy.floorTier).toBe(window.floor);
    const all = [...ladder.candidates, ...(ladder.reachable ?? [])];
    ladder.candidates.forEach((start, k) => {
      const path = ladder.paths![k]!;
      expect(path[0]).toBe(k);
      const priced = path.map((j) => `${all[j]!.tier}:${all[j]!.model}#${all[j]!.variant ?? "default"}`);
      const runner = runnerTrace(policy, TIERS, start);
      expect(priced).toEqual(runner.trace);
      expect(path.every((j) => all[j]!.rank >= rankOf(window.floor) && all[j]!.rank <= rankOf(window.ceiling))).toBe(true);
    });
  });

  it("the window policy never escalates above the ceiling (the unrestricted one does)", () => {
    const single = cfgOf(TIERS, { maxAttemptsPerTier: 1, maxTotalAttempts: 6, costCeiling: { multiple: 1000 } });
    const walk = (window: RoleWindow): string[] => {
      const ladder = buildRoleLadder({ cfg: single, facts: { class: "implement", needs: [] }, role: "implementer", window });
      return ladder.paths![0]!.map((j) => ladder.candidates[j]!.tier);
    };
    expect(walk(win("fast", "medium"))).toEqual(["fast", "fast", "medium", "medium"]);
    expect(walk(win("fast", "heavy"))).toEqual(["fast", "fast", "medium", "medium", "heavy", "heavy"]);
  });

  it("no policy for a floor off the escalate ladder", () => {
    expect(roleEscalatePolicy(cfg, win("turbo", "heavy"))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Property (I2): no role decision below the floor or above the ceiling
// ---------------------------------------------------------------------------

describe("property I2: every role dispatch lies in [floor, ceiling] and never below the authority floor", () => {
  const ACTIONS: readonly AuthorityAction[] = ["read", "glob", "grep", "router_git", "router_run", "edit", "webfetch", "websearch"];
  const DETECTIONS: readonly Detection[] = ["deterministic", "grader", "none"];
  const RISKS: readonly Risk[] = ["low", "medium", "high"];
  const SCOPES: readonly Scope[] = ["single", "multi", "repo"];
  const cfg = cfgOf(TIERS, GENEROUS);
  const tiers = escalateLadder(cfg);
  const PRESET: ReadonlyArray<{ model: string; variant: string | null }> = [
    { model: HAIKU, variant: null },
    { model: SONNET, variant: "medium" },
    { model: OPUS, variant: "xhigh" },
  ];

  it("holds for 600 generated dispatches", () => {
    const next = rng(0x84);
    for (let i = 0; i < 600; i++) {
      const spec = role("r", oneOf(next, ["explore", "implement", "general", "review"] as const), ACTIONS, oneOf(next, ORDER), oneOf(next, ORDER));
      const grant = grantOf(...ACTIONS.filter(() => next() < 0.5));
      const detection = oneOf(next, DETECTIONS);
      const raw = facts({ class: oneOf(next, CLASSES), risk: oneOf(next, RISKS), scope: oneOf(next, SCOPES) });
      const routeLine: RouteLine | null = next() < 0.3 ? { risk: oneOf(next, RISKS), scope: oneOf(next, SCOPES), pin: false, ignored: [] } : null;
      const classified = classifiedOf(raw, routeLine);
      const f = effectiveFactsOf(classified);
      const bounds = tierBoundsOf(spec, grant, classified, eff(detection), {
        floorTier: next() < 0.3 ? oneOf(next, ORDER) : null,
        runningTier: next() < 0.3 ? oneOf(next, ORDER) : null,
        pinTier: next() < 0.3 ? oneOf(next, [...ORDER, "turbo"]) : null,
        tiers,
      });
      const ladder = buildRoleLadder({ cfg, facts: f, role: spec.agent, window: bounds });
      const p: Record<string, number> = {};
      const n: Record<string, number> = {};
      for (const c of ladder.candidates) {
        p[keyOfCandidate(f.class, c)] = next();
        n[keyOfCandidate(f.class, c)] = Math.floor(next() * 30);
      }
      const d = decideRole({
        classified,
        ladder,
        detection: eff(detection),
        engine: next() < 0.8 ? "enforce" : "static",
        routing: ROUTING,
        store: next() < 0.9 ? storeOf({ p, n }) : null,
        resume: next() < 0.2 ? oneOf(next, PRESET) : null,
        exploration: { rate: next() * 0.3, decisionID: `prop-${i}` },
      });
      const lo = rankOf(bounds.floor);
      const hi = rankOf(bounds.ceiling);
      const authority = rankOf(authorityFloor(grant, detection, f.risk, f.scope));
      expect(d.dispatch).not.toBeNull();
      const r = d.dispatch!.rank;
      expect(r).toBeGreaterThanOrEqual(lo);
      expect(r).toBeLessThanOrEqual(hi);
      expect(r).toBeGreaterThanOrEqual(authority);
      for (const c of [...ladder.candidates, ...(ladder.reachable ?? [])]) {
        expect(c.rank).toBeGreaterThanOrEqual(lo);
        expect(c.rank).toBeLessThanOrEqual(hi);
      }
      expect(d.propensity).toBeGreaterThan(0);
      expect(d.propensity).toBeLessThanOrEqual(1);
      if (bounds.pinned !== null && !d.reasons.includes("resume:running")) expect(d.dispatch!.tier).toBe(bounds.pinned);
    }
  });
});

// ---------------------------------------------------------------------------
// Senior QA round 1 (QA-P12-1-*)
// ---------------------------------------------------------------------------

describe("QA round 1", () => {
  it("QA-P12-1-1: decideRole reads the raise-only risk from the classify shape (rules high, merged facts low → never-down)", () => {
    const ladder = ladderFor("implement", win("fast", "heavy"));
    const fast = roleKey("implement", HAIKU, null);
    const medium = roleKey("implement", SONNET, "medium");
    const store = storeOf({ p: { [fast]: 0.99, [medium]: 0.5 }, n: { [fast]: 40, [medium]: 40 } });
    const merged = facts({ risk: "low" });
    const rulesHigh = { facts: merged, trace: { rules: facts({ risk: "high" }), routeLine: null } };
    const d = decideRole({ ...input(ladder, { store, detection: "none" }), classified: rulesHigh });
    expect(d.decision.ineligible[fast]).toBe("never-down");
    expect(d.dispatch?.tier).toBe("medium");
    const routeHigh = classifiedOf(merged, { risk: "high", pin: false, ignored: [] });
    expect(decideRole({ ...input(ladder, { store, detection: "none" }), classified: routeHigh }).dispatch?.tier).toBe("medium");
    // the same merged facts without the raising sources do switch down
    expect(decideRole(input(ladder, { store, detection: "none", facts: merged })).dispatch?.tier).toBe("fast");
  });

  it("QA-P12-1-1: high risk from the rules also blocks exploration", () => {
    const ladder = ladderFor("implement", win("fast", "heavy"));
    const rulesHigh = { facts: facts(), trace: { rules: facts({ risk: "high" }), routeLine: null } };
    for (let i = 0; i < 100; i++) {
      const d = decideRole({ ...input(ladder, { exploration: { rate: 0.2, decisionID: `h${i}` } }), classified: rulesHigh });
      expect(d.explore).toBe(false);
    }
  });

  it("QA-P12-2-1: a deterministic claim without the router's gate is grader for the kernel: no exploration", () => {
    const ladder = ladderFor("implement", win("fast", "heavy"));
    const claimed = effectiveDetection({ routerGate: false, claim: "deterministic", acceptance: "deterministic" });
    expect(claimed).toBe("grader");
    const gated = effectiveDetection({ routerGate: true, claim: null, acceptance: null });
    let explored = 0;
    for (let i = 0; i < 100; i++) {
      const exploration = { rate: 0.2, decisionID: `g${i}` };
      expect(decideRole({ ...input(ladder, { exploration }), detection: claimed }).explore).toBe(false);
      if (decideRole({ ...input(ladder, { exploration }), detection: gated }).explore) explored += 1;
    }
    expect(explored).toBeGreaterThan(0);
  });

  describe("QA-P12-1-3: a resume on a model off the ladder is never moved below it", () => {
    const ladder = ladderFor("search", win("fast", "heavy"));
    const search = { facts: facts({ class: "search" }) };

    it("a preset model of a higher tier (another variant) raises to the first rung at its capability rank", () => {
      const d = decideRole(input(ladder, { ...search, resume: { model: OPUS, variant: "max" } }));
      expect(d.reasons).toContain("resume:off-ladder");
      expect(d.base?.tier).toBe("heavy");
      expect(d.dispatch?.tier).toBe("heavy");
    });

    it("an unknown model fails closed to the window ceiling", () => {
      const d = decideRole(input(ladder, { ...search, resume: { model: "openai/gpt-9", variant: null } }));
      expect(d.reasons).toContain("resume:off-ladder:lift");
      expect(d.base?.tier).toBe("heavy");
      const narrow = ladderFor("search", win("fast", "medium"));
      expect(decideRole(input(narrow, { ...search, resume: { model: "openai/gpt-9", variant: null } })).base?.tier).toBe("medium");
    });

    it("a known lower rank never lowers the base", () => {
      const implement = ladderFor("implement", win("fast", "heavy"));
      const d = decideRole(input(implement, { resume: { model: HAIKU, variant: "low" } }));
      expect(d.reasons).toContain("resume:off-ladder");
      expect(d.base?.tier).toBe("medium");
    });
  });

  it("QA-P12-1-5: one tier order for tierBounds and the ladder; an empty window says so and dispatches nothing", () => {
    const cfg = cfgOf(TIERS, { ladder: ["fast", "heavy"] });
    // plan R7: the order is the preset's (presetTierOrder), not the configured escalate ladder
    expect(roleTierOrder(cfg)).toEqual(["fast", "medium", "heavy"]);
    expect(roleTierOrder(CFG)).toEqual(escalateLadder(CFG));
    const bounds = tierBounds(EXPLORER, grantOf(...LOCAL), facts({ class: "search" }), "none", {
      floorTier: null, runningTier: null, pinTier: null, tiers: roleTierOrder(cfg),
    });
    const ladder = buildRoleLadder({ cfg, facts: { class: "search", needs: [] }, role: "explorer", window: bounds });
    expect(ladder.candidates.map((c) => c.tier)).toEqual(["fast", "medium"]);
    // a window named on another order than the ladder's: no candidate, no dispatch, never a fallback
    const mismatched = buildRoleLadder({ cfg, facts: { class: "search", needs: [] }, role: "explorer", window: win("ghost", "ghost") });
    expect(mismatched.reasons).toContain("window:no-candidates");
    expect(decideRole(input(mismatched)).dispatch).toBeNull();
    expect(roleEscalatePolicy(cfg, win("ghost", "ghost"))).toBeNull();
  });

  it("QA-P12-1-7: the ladder's paths are simulated under roleEscalatePolicy (a ladder ending below heavy never escalates past it)", () => {
    const cfg = cfgOf(TIERS, { ...GENEROUS, ladder: ["fast", "medium"] });
    const ladder = buildRoleLadder({ cfg, facts: { class: "implement", needs: [] }, role: "implementer", window: win("fast", "medium") });
    const policy = roleEscalatePolicy(cfg, win("fast", "medium"))!;
    const all = [...ladder.candidates, ...(ladder.reachable ?? [])];
    ladder.candidates.forEach((start, k) => {
      expect(ladder.paths![k]!.map((j) => `${all[j]!.tier}:${all[j]!.model}#${all[j]!.variant ?? "default"}`)).toEqual(runnerTrace(policy, TIERS, start).trace);
    });
  });
});

describe("effectiveFacts (§2.3 raise-only)", () => {
  it("raises risk and scope from the classifier or the route line, never lowers them", () => {
    const base = facts({ risk: "medium", scope: "multi" });
    expect(effectiveFacts(base, {})).toBe(base);
    expect(effectiveFacts(base, { routeLine: { risk: "low", scope: "single" } })).toBe(base);
    expect(effectiveFacts(base, { routeLine: { risk: "high" }, classifier: { risk: "low", scope: "repo" } })).toMatchObject({ risk: "high", scope: "repo" });
  });
});
