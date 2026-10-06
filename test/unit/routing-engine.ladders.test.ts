import { describe, it, expect } from "vitest";
import {
  buildLadder,
  escalateLadder,
  floorRankOf,
  grantsFromTools,
  resolveChosen,
  tierRankOf,
} from "../../src/routing/engine/ladders";
import { decide } from "../../src/routing/engine/kernel";
import type { HostAgentInfo, Ladder } from "../../src/routing/engine/types";
import { DEFAULT_V2_ROLES, resolveRouting } from "../../src/router/config";
import type { RouterConfig, TierConfig } from "../../src/router/config";
import { CLASS_STATIC_TIER, NEEDS, TASK_CLASSES } from "../../src/routing/classify/types";
import type { Need, TaskClass, TaskFacts } from "../../src/routing/classify/types";
import type { ModelPricing } from "../../src/routing/outcomes/types";
import { createOutcomeStore } from "../../src/routing/outcomes/store";
import type { DecisionInput } from "../../src/routing/engine/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ALL_NEEDS: readonly Need[] = ["shell", "web", "edit", "network", "external_dir"];
const HAIKU = "anthropic/claude-haiku-4-5";
const SONNET = "anthropic/claude-sonnet-5-5";
const OPUS = "anthropic/claude-opus-5-5";

function tier(model: string, variant: string | undefined, costRatio: number, extra: Partial<TierConfig> = {}): TierConfig {
  return { model, ...(variant === undefined ? {} : { variant }), costRatio, ...extra };
}

function cfgOf(tiers: Record<string, TierConfig>, over: Partial<RouterConfig> = {}): RouterConfig {
  return { activePreset: "p", presets: { p: tiers }, rules: [], defaultTier: "medium", ...over };
}

/** fast = sonnet#low, medium = sonnet#medium, heavy = opus#xhigh — no effort configured, so coverage applies. */
function plainCfg(over: Partial<RouterConfig> = {}): RouterConfig {
  return cfgOf(
    {
      fast: tier(SONNET, "low", 1),
      medium: tier(SONNET, "medium", 5),
      heavy: tier(OPUS, "xhigh", 20),
    },
    over,
  );
}

function facts(cls: TaskClass, needs: readonly Need[] = []): Pick<TaskFacts, "class" | "needs"> {
  return { class: cls, needs };
}

function routerAgents(ids: readonly string[] = ["fast", "medium", "heavy"]): HostAgentInfo[] {
  return ids.map((id) => ({ id, mode: "subagent", hidden: false, permitted: true, grants: ALL_NEEDS }));
}

function nativeAgent(id: string, model: string | null, grants: readonly Need[], over: Partial<HostAgentInfo> = {}): HostAgentInfo {
  return { id, ...(model === null ? {} : { model }), mode: "subagent", hidden: false, permitted: true, grants, ...over };
}

const EXPLORE = nativeAgent("explore", HAIKU, ["web"]);
const GENERAL = nativeAgent("general", SONNET, ["shell", "web", "edit", "network"]);

/** The D12 v2 default roles (the 1.1 resolution), not a hand-copied table. */
const V2_ROLES = resolveRouting(plainCfg(), "v2").roles;

function summary(ladder: Ladder): string[] {
  return ladder.candidates.map((c, k) => `${c.agent.origin}:${c.agent.id} ${c.model}#${c.variant ?? "default"} r${c.rank} ->${ladder.next[k] ?? "end"}`);
}

// ---------------------------------------------------------------------------
// escalateLadder / ranks / grants
// ---------------------------------------------------------------------------

describe("escalateLadder and ranks", () => {
  it("is the default fast → medium → heavy, one source for ranks", () => {
    const cfg = plainCfg();
    expect(escalateLadder(cfg)).toEqual(["fast", "medium", "heavy"]);
    expect(tierRankOf(cfg, "fast")).toBe(0);
    expect(tierRankOf(cfg, "heavy")).toBe(2);
    expect(tierRankOf(cfg, "ghost")).toBeNull();
    expect(tierRankOf(cfg, null)).toBeNull();
    expect(tierRankOf(cfg, undefined)).toBeNull();
    expect(floorRankOf(cfg)).toBeNull();
  });

  it("follows enforcement.escalate, de-duplicates and drops tiers without a rung", () => {
    const cfg = plainCfg({ enforcement: { escalate: { ladder: ["heavy", "fast", "heavy", "ghost", "medium"], floorTier: "medium" } } });
    expect(escalateLadder(cfg)).toEqual(["heavy", "fast", "medium"]);
    expect(tierRankOf(cfg, "medium")).toBe(2);
    expect(floorRankOf(cfg)).toBe(2);
    expect(floorRankOf(plainCfg({ enforcement: { escalate: { floorTier: "ghost" } } }))).toBeNull();
  });

  it("an unknown active preset has no ladder", () => {
    expect(escalateLadder(plainCfg({ activePreset: "nope" }))).toEqual([]);
  });
});

describe("grantsFromTools (A11)", () => {
  it("maps the S2 native tool sets to needs, unique and in NEEDS order", () => {
    expect(grantsFromTools(["webfetch", "websearch", "read", "grep"], false)).toEqual(["web"]);
    expect(grantsFromTools(["bash", "webfetch", "edit", "write"], false)).toEqual(["shell", "web", "edit", "network"]);
    expect(grantsFromTools(["shell", "websearch", "patch", "apply_patch", "read"], true)).toEqual([...NEEDS]);
    expect(grantsFromTools([], false)).toEqual([]);
    expect(grantsFromTools(["read", "glob"], true)).toEqual(["external_dir"]);
  });

  it("is case-insensitive on tool ids", () => {
    expect(grantsFromTools(["Bash", "WebFetch"], false)).toEqual(["shell", "web", "network"]);
  });
});

// ---------------------------------------------------------------------------
// Router rungs
// ---------------------------------------------------------------------------

describe("buildLadder — router rungs", () => {
  it("single-candidate tiers: one rung per tier, next = the next tier's first rung, last gives up", () => {
    const ladder = buildLadder({ cfg: plainCfg(), routing: { roles: {} }, facts: facts("implement"), agents: routerAgents() });
    expect(summary(ladder)).toEqual([
      `router:fast ${SONNET}#low r0 ->1`,
      `router:medium ${SONNET}#medium r1 ->2`,
      `router:heavy ${OPUS}#xhigh r2 ->end`,
    ]);
    expect(ladder.candidates.map((c) => c.costRatio)).toEqual([1, 5, 20]);
    expect(ladder.candidates.every((c) => c.source === "tier" && c.grants !== null)).toBe(true);
    expect(ladder.classRank).toBe(1);
    expect(ladder.excluded).toEqual([]);
  });

  it("classRank is the rank of the class's static tier; null for `other`", () => {
    const base = { cfg: plainCfg(), routing: { roles: {} }, agents: routerAgents() } as const;
    expect(buildLadder({ ...base, facts: facts("search") }).classRank).toBe(0);
    expect(buildLadder({ ...base, facts: facts("design") }).classRank).toBe(2);
    expect(buildLadder({ ...base, facts: facts("other") }).classRank).toBeNull();
  });

  it("variants before models: candidates are laid out in order and the next variant comes before the next tier", () => {
    const cfg = cfgOf({
      fast: tier(HAIKU, "low", 1),
      medium: tier(SONNET, "medium", 5, { candidates: [{ variant: "medium", costRatio: 5 }, { variant: "high", costRatio: 7 }] }),
      heavy: tier(OPUS, "xhigh", 20),
    });
    const ladder = buildLadder({ cfg, routing: { roles: {} }, facts: facts("implement"), agents: routerAgents() });
    expect(summary(ladder)).toEqual([
      `router:fast ${HAIKU}#low r0 ->1`,
      `router:medium ${SONNET}#medium r1 ->2`,
      `router:medium ${SONNET}#high r1 ->3`,
      `router:heavy ${OPUS}#xhigh r2 ->end`,
    ]);
    expect(ladder.candidates.map((c) => c.costRatio)).toEqual([1, 5, 7, 20]);
  });

  it("a rung already covered by the one just tried is skipped (fast = sonnet#high, medium = sonnet#medium)", () => {
    const cfg = cfgOf({
      fast: tier(SONNET, "high", 1),
      medium: tier(SONNET, "medium", 5),
      heavy: tier(OPUS, "xhigh", 20),
    });
    const ladder = buildLadder({ cfg, routing: { roles: {} }, facts: facts("implement"), agents: routerAgents() });
    expect(ladder.next).toEqual([2, 2, null]); // fast skips medium (covered by high); medium → heavy
  });

  it("effort-configured tiers are never covered (A20)", () => {
    const covered = cfgOf({
      fast: tier(SONNET, "high", 1),
      medium: tier(SONNET, "medium", 5),
      heavy: tier(OPUS, "xhigh", 20),
    });
    for (const effortTier of ["fast", "medium"]) {
      const cfg = {
        ...covered,
        presets: { p: { ...covered.presets.p, [effortTier]: { ...covered.presets.p![effortTier]!, effort: "medium" as const } } },
      };
      const ladder = buildLadder({ cfg, routing: { roles: {} }, facts: facts("implement"), agents: routerAgents() });
      expect(ladder.next, effortTier).toEqual([1, 2, null]);
    }
  });

  it("the same variant on the same model is covered even across tiers", () => {
    const cfg = cfgOf({ fast: tier(SONNET, "low", 1), medium: tier(SONNET, "low", 5), heavy: tier(OPUS, "xhigh", 20) });
    expect(buildLadder({ cfg, routing: { roles: {} }, facts: facts("implement"), agents: routerAgents() }).next).toEqual([2, 2, null]);
  });

  it("router grants come from the supplied agents; null when agents are unavailable", () => {
    const cfg = plainCfg();
    const withGrants = buildLadder({ cfg, routing: { roles: {} }, facts: facts("implement"), agents: [{ ...routerAgents(["fast"])[0]!, grants: ["web"] }, ...routerAgents(["medium"])] });
    expect(withGrants.candidates.map((c) => c.grants)).toEqual([["web"], ALL_NEEDS, null]);
    const none = buildLadder({ cfg, routing: { roles: V2_ROLES }, facts: facts("search"), agents: null });
    expect(none.candidates.map((c) => c.grants)).toEqual([null, null, null]);
    expect(none.candidates.every((c) => c.source === "tier")).toBe(true);
  });

  it("attaches catalog pricing only when a lookup is supplied", () => {
    const priced: ModelPricing = [{ input: 3, output: 15 }];
    const seen: string[] = [];
    const ladder = buildLadder({
      cfg: plainCfg(),
      routing: { roles: {} },
      facts: facts("implement"),
      agents: routerAgents(),
      pricing: (model) => {
        seen.push(model);
        return model === OPUS ? undefined : priced;
      },
    });
    expect(ladder.candidates.map((c) => c.pricing)).toEqual([priced, priced, undefined]);
    expect(seen).toContain(SONNET);
    const bare = buildLadder({ cfg: plainCfg(), routing: { roles: {} }, facts: facts("implement"), agents: routerAgents() });
    expect(bare.candidates.every((c) => !("pricing" in c))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Role rungs (D12, D7)
// ---------------------------------------------------------------------------

describe("buildLadder — roles with native agents (D12 default roles)", () => {
  const agents = [...routerAgents(), EXPLORE, GENERAL];

  it("explore: own model first (inherits fast's rank and ratio), then the fast ladder, then medium's first rung", () => {
    const ladder = buildLadder({ cfg: plainCfg(), routing: { roles: V2_ROLES }, facts: facts("search"), agents });
    expect(summary(ladder)).toEqual([
      `router:fast ${SONNET}#low r0 ->1`,
      `router:medium ${SONNET}#medium r1 ->2`,
      `router:heavy ${OPUS}#xhigh r2 ->end`,
      `host:explore ${HAIKU}#default r0 ->4`,
      `host:explore ${SONNET}#low r0 ->1`, // last rung of the chain → medium's first rung (coverage-skipped: medium#medium is not covered by #low)
    ]);
    const own = ladder.candidates[3]!;
    expect(own.source).toBe("role-own-model");
    expect(own.costRatio).toBe(1); // inherited from the owning tier's first rung, never invented
    expect(own.tier).toBe("fast");
    expect(own.grants).toEqual(["web"]);
    expect(ladder.candidates[4]!.source).toBe("role-tier-rung");
    expect(ladder.candidates[4]!.agent).toEqual({ origin: "host", id: "explore" });
    expect(ladder.candidates[4]!.rank).toBe(0);
    expect(ladder.classRank).toBe(0);
    expect(ladder.excluded).toEqual([]);
  });

  it("general: own model first, then the medium ladder, then heavy", () => {
    const ladder = buildLadder({ cfg: plainCfg(), routing: { roles: V2_ROLES }, facts: facts("implement"), agents });
    // own = sonnet#default == medium's family: ratio of the same (model, variant) pair does not exist → medium's first rung (5)
    const chain = ladder.candidates.slice(3);
    expect(chain.map((c) => `${c.source} ${c.model}#${c.variant ?? "default"} r${c.rank} x${c.costRatio}`)).toEqual([
      `role-own-model ${SONNET}#default r1 x5`,
      `role-tier-rung ${SONNET}#medium r1 x5`,
    ]);
    expect(ladder.next.slice(3)).toEqual([4, 2]); // own → tier rung → heavy
    expect(ladder.classRank).toBe(1);
  });

  it("the own-model rung takes the ratio of the router rung with the same (model, variant)", () => {
    const owned = nativeAgent("explore", `${SONNET}#medium`, ["web"]);
    const ladder = buildLadder({ cfg: plainCfg(), routing: { roles: { search: ["explore"] } }, facts: facts("search"), agents: [...routerAgents(), owned] });
    const own = ladder.candidates.find((c) => c.source === "role-own-model")!;
    expect(own.variant).toBe("medium");
    expect(own.costRatio).toBe(5); // medium's ratio for sonnet#medium, even though the owning tier is fast
    expect(own.rank).toBe(0);
  });

  it("a tier rung identical to the own rung is dropped as a duplicate", () => {
    const owned = nativeAgent("explore", `${SONNET}#low`, ["web"]);
    const ladder = buildLadder({ cfg: plainCfg(), routing: { roles: { search: ["explore"] } }, facts: facts("search"), agents: [...routerAgents(), owned] });
    expect(ladder.candidates.filter((c) => c.agent.id === "explore")).toHaveLength(1);
    expect(ladder.excluded).toEqual([{ agent: { origin: "host", id: "explore" }, model: SONNET, variant: "low", why: "duplicate" }]);
    expect(ladder.next[3]).toBe(1); // own rung → medium (the chain has no more rungs)
  });

  it("an agent without a model gets no own rung (it runs on the parent's model)", () => {
    const bare = nativeAgent("explore", null, ["web"]);
    const ladder = buildLadder({ cfg: plainCfg(), routing: { roles: { search: ["explore"] } }, facts: facts("search"), agents: [...routerAgents(), bare] });
    expect(ladder.candidates.slice(3).map((c) => c.source)).toEqual(["role-tier-rung"]);
  });

  it("chains follow routing.roles order and every chain ends in the router rungs above the owning tier", () => {
    const second = nativeAgent("scout", HAIKU, ["web"]);
    const ladder = buildLadder({ cfg: plainCfg(), routing: { roles: { search: ["scout", "explore"] } }, facts: facts("search"), agents: [...routerAgents(), EXPLORE, second] });
    expect(ladder.candidates.slice(3).map((c) => c.agent.id)).toEqual(["scout", "scout", "explore", "explore"]);
    expect(ladder.next.slice(3)).toEqual([4, 1, 6, 1]);
  });

  it("the last tier's role chain gives up", () => {
    const architect = nativeAgent("architect", OPUS, ["web"]);
    const ladder = buildLadder({ cfg: plainCfg(), routing: { roles: { design: ["architect"] } }, facts: facts("design"), agents: [...routerAgents(), architect] });
    expect(ladder.next.slice(3)).toEqual([4, null]);
  });
});

describe("buildLadder — needs and exclusions", () => {
  const agents = [...routerAgents(), EXPLORE, GENERAL];

  it("`needs: [shell]` excludes explore (A11); general stays", () => {
    const search = buildLadder({ cfg: plainCfg(), routing: { roles: V2_ROLES }, facts: facts("search", ["shell"]), agents });
    expect(search.candidates.some((c) => c.agent.id === "explore")).toBe(false);
    expect(search.excluded).toEqual([{ agent: { origin: "host", id: "explore" }, model: HAIKU, variant: null, why: "needs" }]);
    const implement = buildLadder({ cfg: plainCfg(), routing: { roles: V2_ROLES }, facts: facts("implement", ["shell", "edit"]), agents });
    expect(implement.candidates.some((c) => c.agent.id === "general")).toBe(true);
    expect(implement.excluded).toEqual([]);
  });

  it("an agent with no grants covers nothing but the empty need set", () => {
    const blind = nativeAgent("explore", HAIKU, []);
    const roles = { search: ["explore"] };
    expect(buildLadder({ cfg: plainCfg(), routing: { roles }, facts: facts("search"), agents: [...routerAgents(), blind] }).candidates.some((c) => c.agent.id === "explore")).toBe(true);
    expect(buildLadder({ cfg: plainCfg(), routing: { roles }, facts: facts("search", ["web"]), agents: [...routerAgents(), blind] }).excluded.map((e) => e.why)).toEqual(["needs"]);
  });

  it("reserved, absent, primary, hidden and not-permitted agents are agent-unavailable (QA-1.1-18/29)", () => {
    const roles = { search: ["build", "ghost", "pilot", "stealth", "denied", "explore"] };
    const hostAgents = [
      ...routerAgents(),
      nativeAgent("build", SONNET, ALL_NEEDS),
      nativeAgent("pilot", SONNET, ALL_NEEDS, { mode: "primary" }),
      nativeAgent("stealth", SONNET, ALL_NEEDS, { hidden: true }),
      nativeAgent("denied", SONNET, ALL_NEEDS, { permitted: false }),
      EXPLORE,
    ];
    const ladder = buildLadder({ cfg: plainCfg(), routing: { roles }, facts: facts("search"), agents: hostAgents });
    expect(ladder.excluded.map((e) => `${e.agent.id}:${e.why}`)).toEqual([
      "build:agent-unavailable",
      "ghost:agent-unavailable",
      "pilot:agent-unavailable",
      "stealth:agent-unavailable",
      "denied:agent-unavailable",
    ]);
    expect(new Set(ladder.candidates.slice(3).map((c) => c.agent.id))).toEqual(new Set(["explore"]));
  });

  it("a role naming a router tier of the preset is a duplicate", () => {
    const ladder = buildLadder({ cfg: plainCfg(), routing: { roles: { search: ["fast"] } }, facts: facts("search"), agents: routerAgents() });
    expect(ladder.candidates).toHaveLength(3);
    expect(ladder.excluded).toEqual([{ agent: { origin: "router", id: "fast" }, model: "", variant: null, why: "duplicate" }]);
  });

  it("a class without an owning tier excludes every role agent (no inherited rank, D7)", () => {
    const ladder = buildLadder({ cfg: plainCfg(), routing: { roles: { other: ["explore"] } }, facts: facts("other"), agents });
    expect(ladder.candidates).toHaveLength(3);
    expect(ladder.excluded.map((e) => e.why)).toEqual(["no-owning-tier"]);
    // A static tier that is not on the escalate ladder has no rank either.
    const noHeavy = buildLadder({
      cfg: plainCfg({ enforcement: { escalate: { ladder: ["fast", "medium"] } } }),
      routing: { roles: { design: ["general"] } },
      facts: facts("design"),
      agents,
    });
    expect(noHeavy.excluded.map((e) => e.why)).toEqual(["no-owning-tier"]);
    expect(noHeavy.classRank).toBeNull();
  });

  it("agents === null: no role candidates, every role agent is unavailable", () => {
    const ladder = buildLadder({ cfg: plainCfg(), routing: { roles: V2_ROLES }, facts: facts("search"), agents: null });
    expect(ladder.candidates.every((c) => c.source === "tier")).toBe(true);
    expect(ladder.excluded.map((e) => e.why)).toEqual(["agent-unavailable"]);
  });

  it("roles of another class are not used; lookup is by own property", () => {
    const ladder = buildLadder({ cfg: plainCfg(), routing: { roles: { review: ["general"] } }, facts: facts("search"), agents });
    expect(ladder.candidates).toHaveLength(3);
    expect(ladder.excluded).toEqual([]);
    const inherited = buildLadder({ cfg: plainCfg(), routing: { roles: Object.create({ search: ["explore"] }) as Record<string, string[]> }, facts: facts("search"), agents });
    expect(inherited.candidates).toHaveLength(3);
  });

  it("v2 default roles are the D12 table", () => {
    expect(V2_ROLES).toEqual(DEFAULT_V2_ROLES);
  });
});

// ---------------------------------------------------------------------------
// Empty ladders
// ---------------------------------------------------------------------------

describe("buildLadder — empty ladder after filtering is kept with a reason", () => {
  it("unknown preset → no candidates → the kernel keeps the chosen dispatch (kept:no-candidates)", () => {
    const cfg = plainCfg({ activePreset: "nope" });
    const ladder = buildLadder({ cfg, routing: { roles: V2_ROLES }, facts: facts("search"), agents: [...routerAgents(), EXPLORE] });
    expect(ladder.candidates).toEqual([]);
    expect(ladder.next).toEqual([]);
    expect(ladder.classRank).toBeNull();
    const decision = decide({
      facts: { class: "search", risk: "low", scope: "single", needs: [], confidence: 1, source: "rules" },
      chosen: { agent: { origin: "host", id: "explore" }, model: HAIKU, variant: null },
      ladder,
      detection: "none",
      pin: false,
      routing: { profile: "balanced", margin: 0.2, minClassConfidence: 0.7, detection: { deterministic: 0.95, grader: 0.7, none: 0.3 } },
      store: null,
    });
    expect(decision.switched).toBe(false);
    expect(decision.reasonCode).toBe("kept:no-candidates");
    expect(decision.best).toBeNull();
  });

  it("a ladder whose tiers are all unresolvable is empty too", () => {
    const cfg = plainCfg({ enforcement: { escalate: { ladder: ["ghost"] } } });
    const ladder = buildLadder({ cfg, routing: { roles: {} }, facts: facts("implement"), agents: routerAgents() });
    expect(ladder.candidates).toEqual([]);
    expect(ladder.next).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// resolveChosen
// ---------------------------------------------------------------------------

describe("resolveChosen", () => {
  const cfg = cfgOf({
    fast: tier(SONNET, "low", 1),
    medium: tier(SONNET, "medium", 5),
    heavy: tier(OPUS, "xhigh", 20),
  });
  const agents = [...routerAgents(), EXPLORE, nativeAgent("bare", null, [])];

  it("a router tier resolves to its own base rung (origin router)", () => {
    expect(resolveChosen({ cfg, agents, agent: "medium" })).toEqual({ agent: { origin: "router", id: "medium" }, model: SONNET, variant: "medium" });
    expect(resolveChosen({ cfg, agents: null, agent: "heavy" })).toEqual({ agent: { origin: "router", id: "heavy" }, model: OPUS, variant: "xhigh" });
  });

  it("the call's model wins and its #variant is split off", () => {
    expect(resolveChosen({ cfg, agents, agent: "fast", model: `${OPUS}#high` })).toEqual({ agent: { origin: "router", id: "fast" }, model: OPUS, variant: "high" });
    expect(resolveChosen({ cfg, agents, agent: "fast", model: OPUS })).toEqual({ agent: { origin: "router", id: "fast" }, model: OPUS, variant: null });
  });

  it("a host agent resolves to the call's model, its configured model, then the parent's", () => {
    expect(resolveChosen({ cfg, agents, agent: "explore" })).toEqual({ agent: { origin: "host", id: "explore" }, model: HAIKU, variant: null });
    expect(resolveChosen({ cfg, agents, agent: "explore", model: SONNET })).toEqual({ agent: { origin: "host", id: "explore" }, model: SONNET, variant: null });
    expect(resolveChosen({ cfg, agents, agent: "bare", parentModel: `${OPUS}#max` })).toEqual({ agent: { origin: "host", id: "bare" }, model: OPUS, variant: "max" });
    expect(resolveChosen({ cfg, agents: null, agent: "explore", parentModel: SONNET })).toEqual({ agent: { origin: "host", id: "explore" }, model: SONNET, variant: null });
  });

  it("null when nothing resolves", () => {
    expect(resolveChosen({ cfg, agents, agent: "bare" })).toBeNull();
    expect(resolveChosen({ cfg, agents, agent: "ghost", model: "  ", parentModel: null })).toBeNull();
    expect(resolveChosen({ cfg, agents, agent: "" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// QA-1.4 round 1: ranks of own-model rungs, tier availability, parent model, pricing failures
// ---------------------------------------------------------------------------

const ROUTING = { profile: "balanced", margin: 0.2, minClassConfidence: 0.7, detection: { deterministic: 0.95, grader: 0.7, none: 0.3 } } as const;

function decisionInput(over: Partial<DecisionInput> & Pick<DecisionInput, "ladder" | "chosen">): DecisionInput {
  return {
    facts: { class: "implement", risk: "high", scope: "single", needs: [], confidence: 1, source: "rules" },
    detection: "none",
    pin: false,
    routing: ROUTING,
    store: createOutcomeStore(),
    ...over,
  };
}

describe("QA-1.4-1: an own-model rung takes the price AND the rank of the matching preset rung (A25)", () => {
  const agents = [...routerAgents(), nativeAgent("general", `${SONNET}#low`, ["shell", "web", "edit", "network"])];
  const roles = { implement: ["general"] };

  it("general on fast's model is a fast-ranked rung of the fast tier, not a medium-ranked one", () => {
    const ladder = buildLadder({ cfg: plainCfg(), routing: { roles }, facts: facts("implement", ["edit"]), agents });
    const own = ladder.candidates.find((c) => c.source === "role-own-model")!;
    expect(own).toMatchObject({ model: SONNET, variant: "low", costRatio: 1, rank: 0, tier: "fast" });
    expect(ladder.classRank).toBe(1);
  });

  it("the owning tier's rank only caps it: a match on a higher tier keeps the inherited rank", () => {
    const heavy = nativeAgent("general", `${OPUS}#xhigh`, ["shell", "web", "edit", "network"]);
    const ladder = buildLadder({ cfg: plainCfg(), routing: { roles }, facts: facts("implement", ["edit"]), agents: [...routerAgents(), heavy] });
    const own = ladder.candidates.find((c) => c.source === "role-own-model")!;
    expect(own).toMatchObject({ costRatio: 20, rank: 1, tier: "medium" }); // price from heavy's rung, rank capped by the owning tier
  });

  it("inherited rank and the owning tier's first ratio apply only when no rung matches", () => {
    const other = nativeAgent("general", `${SONNET}#max`, ["shell", "web", "edit", "network"]);
    const ladder = buildLadder({ cfg: plainCfg(), routing: { roles }, facts: facts("implement", ["edit"]), agents: [...routerAgents(), other] });
    expect(ladder.candidates.find((c) => c.source === "role-own-model")).toMatchObject({ costRatio: 5, rank: 1, tier: "medium" });
  });

  it("probe: risk high, d none, empty store → the cheaper own-model rung is never-down ineligible and nothing switches", () => {
    const ladder = buildLadder({ cfg: plainCfg(), routing: { roles }, facts: facts("implement", ["edit"]), agents });
    const chosen = resolveChosen({ cfg: plainCfg(), agents, agent: "medium" })!;
    const decision = decide(decisionInput({ ladder, chosen, facts: { class: "implement", risk: "high", scope: "single", needs: ["edit"], confidence: 1, source: "rules" } }));
    expect(decision.switched).toBe(false);
    expect(Object.values(decision.ineligible)).toContain("never-down");
    expect(decision.ineligible["implement|host:general|anthropic/claude-sonnet-5-5#low"]).toBe("never-down");
    expect(decision.best?.agent).toBe("medium");
  });

  it("priors alone do not switch: medium risk + deliverable detection, empty store → kept:evidence (A24)", () => {
    const ladder = buildLadder({ cfg: plainCfg(), routing: { roles }, facts: facts("implement", ["edit"]), agents });
    const chosen = resolveChosen({ cfg: plainCfg(), agents, agent: "medium" })!;
    const decision = decide(decisionInput({ ladder, chosen, detection: "deterministic", facts: { class: "implement", risk: "medium", scope: "single", needs: ["edit"], confidence: 1, source: "rules" } }));
    expect(decision.best?.agent).not.toBe("medium"); // the priors do prefer a cheaper rung ...
    expect(decision.switched).toBe(false); // ... but there is no recorded outcome behind it
    expect(decision.reasonCode).toBe("kept:evidence");
  });

  it("floor tier: the fast-ranked own-model rung is below a medium floor and never best", () => {
    const cfg = plainCfg({ enforcement: { escalate: { floorTier: "medium" } } });
    const ladder = buildLadder({ cfg, routing: { roles }, facts: facts("implement", ["edit"]), agents });
    const chosen = resolveChosen({ cfg, agents, agent: "medium" })!;
    const decision = decide(decisionInput({ ladder, chosen, floorRank: floorRankOf(cfg), detection: "deterministic", facts: { class: "implement", risk: "medium", scope: "single", needs: ["edit"], confidence: 1, source: "rules" } }));
    expect(decision.ineligible["implement|host:general|anthropic/claude-sonnet-5-5#low"]).toBe("floor");
    expect(decision.ineligible["implement|router:fast|anthropic/claude-sonnet-5-5#low"]).toBe("floor");
    expect(decision.switched).toBe(false);
  });
});

describe("QA-1.4-3: router tier rungs honour permitted, hidden and mode", () => {
  const unavailable: ReadonlyArray<readonly [string, Partial<HostAgentInfo>]> = [
    ["not permitted", { permitted: false }],
    ["hidden", { hidden: true }],
    ["mode primary", { mode: "primary" }],
  ];
  for (const [name, over] of unavailable) {
    it(`a ${name} tier agent is excluded as agent-unavailable and can never be best`, () => {
      const agents = routerAgents().map((a) => (a.id === "fast" ? { ...a, ...over } : a));
      const ladder = buildLadder({ cfg: plainCfg(), routing: { roles: {} }, facts: facts("search"), agents });
      expect(ladder.candidates.map((c) => c.agent.id)).toEqual(["medium", "heavy"]);
      expect(ladder.excluded).toEqual([{ agent: { origin: "router", id: "fast" }, model: SONNET, variant: "low", why: "agent-unavailable" }]);
      expect(ladder.classRank).toBe(0); // ranks stay the escalate ladder's
      expect(ladder.candidates.map((c) => c.rank)).toEqual([1, 2]);
      const chosen = resolveChosen({ cfg: plainCfg(), agents, agent: "medium" })!;
      const decision = decide(decisionInput({ ladder, chosen, facts: { class: "search", risk: "low", scope: "single", needs: [], confidence: 1, source: "rules" } }));
      expect(decision.best?.agent).not.toBe("fast");
      expect(Object.keys(decision.costs).some((key) => key.includes("router:fast"))).toBe(false);
    });
  }

  it("a tier absent from the agent list is not excluded (grants stay unknown)", () => {
    const ladder = buildLadder({ cfg: plainCfg(), routing: { roles: {} }, facts: facts("search"), agents: routerAgents(["medium", "heavy"]) });
    expect(ladder.candidates.map((c) => [c.agent.id, c.grants === null])).toEqual([["fast", true], ["medium", false], ["heavy", false]]);
    expect(ladder.excluded).toEqual([]);
  });

  it("an unavailable tier's rung still prices the own-model rung that matches it", () => {
    const agents = [...routerAgents().map((a) => (a.id === "fast" ? { ...a, hidden: true } : a)), nativeAgent("general", `${SONNET}#low`, ["edit"])];
    const ladder = buildLadder({ cfg: plainCfg(), routing: { roles: { implement: ["general"] } }, facts: facts("implement", ["edit"]), agents });
    expect(ladder.candidates.find((c) => c.source === "role-own-model")).toMatchObject({ costRatio: 1, rank: 0 });
  });
});

describe("QA-1.4-4: an agent without a configured model runs on the parent's model", () => {
  const parentModel = `${OPUS}#xhigh`;
  const bare = nativeAgent("general", null, ["shell", "web", "edit", "network"]);
  const agents = [...routerAgents(), bare];
  const roles = { implement: ["general"] };

  it("gets an own-model rung on the parent's model, priced and ranked by the matching rung", () => {
    const ladder = buildLadder({ cfg: plainCfg(), routing: { roles }, facts: facts("implement", ["edit"]), agents, parentModel });
    const own = ladder.candidates.find((c) => c.source === "role-own-model")!;
    expect(own).toMatchObject({ agent: { origin: "host", id: "general" }, model: OPUS, variant: "xhigh", costRatio: 20, rank: 1, tier: "medium" });
  });

  it("without a parent model there is no own rung", () => {
    const ladder = buildLadder({ cfg: plainCfg(), routing: { roles }, facts: facts("implement", ["edit"]), agents });
    expect(ladder.candidates.filter((c) => c.source === "role-own-model")).toEqual([]);
    expect(ladder.candidates.filter((c) => c.source === "role-tier-rung")).toHaveLength(1);
  });

  it("the configured model wins over the parent's", () => {
    const configured = [...routerAgents(), nativeAgent("general", HAIKU, ["edit"])];
    const ladder = buildLadder({ cfg: plainCfg(), routing: { roles }, facts: facts("implement", ["edit"]), agents: configured, parentModel });
    expect(ladder.candidates.find((c) => c.source === "role-own-model")?.model).toBe(HAIKU);
  });

  it("chosen `general` on opus#xhigh resolves to a candidate (no kept:chosen-not-candidate)", () => {
    const ladder = buildLadder({ cfg: plainCfg(), routing: { roles }, facts: facts("implement", ["edit"]), agents, parentModel });
    const chosen = resolveChosen({ cfg: plainCfg(), agents, agent: "general", parentModel })!;
    expect(chosen).toEqual({ agent: { origin: "host", id: "general" }, model: OPUS, variant: "xhigh" });
    const decision = decide(decisionInput({ ladder, chosen, facts: { class: "implement", risk: "medium", scope: "single", needs: ["edit"], confidence: 1, source: "rules" } }));
    expect(decision.reasonCode).not.toBe("kept:chosen-not-candidate");
    expect(decision.chosen.key).toBe("implement|host:general|anthropic/claude-opus-5-5#xhigh");
    expect(Object.keys(decision.costs)).toContain(decision.chosen.key);
  });
});

describe("QA-1.4-10: a failing pricing lookup prices as unpriced", () => {
  const input = { cfg: plainCfg(), routing: { roles: {} }, facts: facts("implement"), agents: routerAgents() } as const;

  it("a throwing lookup leaves that model unpriced, logs once per lookup, and never throws", () => {
    const warnings: string[] = [];
    const priced: ModelPricing = [{ input: 3, output: 15 }];
    const ladder = buildLadder({
      ...input,
      pricing: (model) => {
        if (model === OPUS) throw new Error("catalog exploded");
        return priced;
      },
      logger: { warn: (message) => void warnings.push(message) },
    });
    expect(ladder.candidates.map((c) => c.pricing)).toEqual([priced, priced, undefined]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(OPUS);
    expect(warnings[0]).toContain("catalog exploded");
  });

  it("works without a logger, with a throwing logger and with a non-Error throw", () => {
    expect(() => buildLadder({ ...input, pricing: () => { throw "plain string"; } })).not.toThrow();
    const ladder = buildLadder({
      ...input,
      pricing: () => { throw new Error("x"); },
      logger: { warn: () => { throw new Error("logger broke"); } },
    });
    expect(ladder.candidates.every((c) => c.pricing === undefined)).toBe(true);
    expect(ladder.candidates).toHaveLength(3);
  });
});
// ---------------------------------------------------------------------------
// Property: no cycle can exist (plan "cycle impossible")
// ---------------------------------------------------------------------------

/** mulberry32 — a seeded generator so a failure is reproducible from its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MODELS = [HAIKU, SONNET, OPUS, "openai/gpt-6-luna-fast"];
const VARIANTS: (string | undefined)[] = [undefined, "low", "medium", "high", "xhigh", "max"];
const TIER_NAMES = ["fast", "medium", "heavy", "turbo"];
const AGENT_IDS = ["explore", "general", "scout", "build", "ghost", "fast", "medium", "heavy", "turbo"];

function pick<T>(random: () => number, list: readonly T[]): T {
  return list[Math.floor(random() * list.length)]!;
}

interface Scenario {
  readonly cfg: RouterConfig;
  readonly roles: Record<string, string[]>;
  readonly agents: HostAgentInfo[] | null;
  readonly cls: TaskClass;
  readonly needs: Need[];
}

function scenario(seed: number): Scenario {
  const random = rng(seed);
  const tierCount = 1 + Math.floor(random() * 4);
  const names = TIER_NAMES.slice(0, tierCount);
  const tiers: Record<string, TierConfig> = {};
  let ratio = 1;
  for (const name of names) {
    ratio += Math.floor(random() * 6);
    const model = pick(random, MODELS);
    const variant = pick(random, VARIANTS);
    const config: TierConfig = tier(model, variant, ratio);
    if (random() < 0.25) config.effort = "medium";
    if (random() < 0.4) {
      // A valid explicit list: the tier's own rung first, then up to two more with non-decreasing ratios.
      const list = [{ ...(variant === undefined ? {} : { variant }), costRatio: ratio }];
      let r = ratio;
      for (let i = Math.floor(random() * 3); i > 0; i--) {
        r += Math.floor(random() * 3);
        const extraVariant = pick(random, VARIANTS);
        if (extraVariant === variant) continue;
        list.push({ ...(extraVariant === undefined ? {} : { variant: extraVariant }), costRatio: r });
      }
      config.candidates = list;
    }
    tiers[name] = config;
  }
  const ladderOrder = random() < 0.3 ? [...names].reverse() : names;
  const cfg = cfgOf(tiers, { enforcement: { escalate: { ladder: ladderOrder } } });

  const cls = pick(random, TASK_CLASSES);
  const needs = NEEDS.filter(() => random() < 0.2);
  const roles: Record<string, string[]> = {};
  for (const c of TASK_CLASSES) {
    if (random() < 0.6) roles[c] = Array.from({ length: Math.floor(random() * 4) }, () => pick(random, AGENT_IDS));
  }
  const agents: HostAgentInfo[] | null =
    random() < 0.1
      ? null
      : AGENT_IDS.filter(() => random() < 0.85).map((id) =>
          nativeAgent(id, random() < 0.8 ? `${pick(random, MODELS)}${random() < 0.5 ? `#${pick(random, VARIANTS.slice(1) as string[])}` : ""}` : null, NEEDS.filter(() => random() < 0.7), {
            mode: random() < 0.15 ? "primary" : "subagent",
            hidden: random() < 0.1,
            permitted: random() < 0.9,
          }),
        );
  return { cfg, roles, agents, cls, needs };
}

describe("buildLadder — acyclic by construction (property, 500 seeded random ladders)", () => {
  it("every pointer is null or in range; router pointers strictly increase; following next terminates without repeating", () => {
    let withRoles = 0;
    for (let seed = 1; seed <= 500; seed++) {
      const s = scenario(seed);
      const ladder = buildLadder({ cfg: s.cfg, routing: { roles: s.roles }, facts: facts(s.cls, s.needs), agents: s.agents });
      const label = `seed ${seed}`;
      const n = ladder.candidates.length;
      expect(ladder.next.length, label).toBe(n);
      const routerCount = ladder.candidates.filter((c) => c.source === "tier").length;
      ladder.candidates.forEach((c, k) => {
        expect(c.source === "tier" ? k < routerCount : k >= routerCount, `${label} layout ${k}`).toBe(true);
        expect(Number.isFinite(c.costRatio) && c.costRatio > 0, `${label} ratio ${k}`).toBe(true);
        expect(c.rank, `${label} rank ${k}`).toBeGreaterThanOrEqual(0);
        const target = ladder.next[k];
        if (target === null) return;
        expect(Number.isInteger(target) && target >= 0 && target < n, `${label} range ${k}→${target}`).toBe(true);
        if (k < routerCount) {
          expect(target, `${label} router ${k}→${target}`).toBeGreaterThan(k);
          expect(target < routerCount, `${label} router stays in block ${k}`).toBe(true);
        } else if (target < routerCount) {
          // A chain leaves into the router rungs of a strictly higher tier only.
          expect(ladder.candidates[target]!.rank, `${label} chain exit ${k}→${target}`).toBeGreaterThan(c.rank);
        } else {
          expect(target, `${label} chain ${k}→${target}`).toBeGreaterThan(k);
          expect(ladder.candidates[target]!.agent, `${label} chain agent ${k}`).toEqual(c.agent);
        }
      });
      for (let start = 0; start < n; start++) {
        const seen = new Set<number>();
        let at: number | null = start;
        let steps = 0;
        while (at !== null) {
          expect(seen.has(at), `${label} repeats ${at} from ${start}`).toBe(false);
          seen.add(at);
          at = ladder.next[at] ?? null;
          steps += 1;
          expect(steps, `${label} runaway from ${start}`).toBeLessThanOrEqual(n);
        }
      }
      if (n > routerCount) withRoles += 1;
    }
    // The generator really exercises role chains (not a vacuous pass).
    expect(withRoles).toBeGreaterThan(40);
  });

  it("is deterministic: equal inputs build equal ladders", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const s = scenario(seed);
      const input = { cfg: s.cfg, routing: { roles: s.roles }, facts: facts(s.cls, s.needs), agents: s.agents };
      expect(buildLadder(input)).toEqual(buildLadder(input));
    }
  });

  it("static tiers of the classes are consistent with the scenario classes", () => {
    // Guard for the generator: every class either has a static tier or is `other`.
    for (const c of TASK_CLASSES) expect(CLASS_STATIC_TIER[c] === null).toBe(c === "other");
  });
});
