// Phase 2.2 QA round 1: the per-turn hint text (QA-2.2-6).
import { describe, expect, it } from "vitest";
import { buildHint } from "../../src/routing/wire/hint";
import type { Candidate, Decision } from "../../src/routing/engine/types";
import { makeKey } from "../../src/routing/outcomes/types";

const choice = (agent: string, variant: string) => ({
  key: makeKey("implement", { origin: "router", id: agent }, "anthropic", "claude-sonnet-5-5", variant),
  agent, origin: "router" as const, model: "anthropic/claude-sonnet-5-5", variant,
});

function target(agent: string, variant: string | null): Candidate {
  return {
    agent: { origin: "router", id: agent }, model: "anthropic/claude-sonnet-5-5", variant, costRatio: 5, rank: 1, tier: agent, source: "tier", grants: [],
  };
}

function decision(over: Partial<Decision> = {}): Decision {
  return {
    chosen: choice("medium", "medium"), best: choice("heavy", "xhigh"), argmin: null, switched: true, pinned: false, confidence: 0.5,
    reasonCode: "switched", reason: "switched: C(best)=5 < (1 − 0.2)·C(chosen)=9 ratio", costs: {}, unit: "ratio", ineligible: {}, target: target("heavy", "xhigh"),
    ...over,
  };
}

describe("buildHint", () => {
  const descriptions = new Map([["heavy", "Opus for architecture and hard debugging"]]);

  it("names the destination agent with its description, the pick it replaces and the reason, in two lines", () => {
    const hint = buildHint(decision(), { class: "implement" }, descriptions)!;
    expect(hint.split("\n")).toHaveLength(2);
    expect(hint).toContain("Route hint: for implement work like this turn, prefer @heavy (Opus for architecture and hard debugging) over @medium.");
    expect(hint).toContain("Why: switched: C(best)=5");
  });

  it("says nothing when nothing would switch, the dispatch is pinned, or there is no target", () => {
    expect(buildHint(decision({ switched: false }), { class: "implement" }, descriptions)).toBeNull();
    expect(buildHint(decision({ pinned: true }), { class: "implement" }, descriptions)).toBeNull();
    expect(buildHint(decision({ target: null }), { class: "implement" }, descriptions)).toBeNull();
    expect(buildHint(decision({ best: null }), { class: "implement" }, descriptions)).toBeNull();
  });

  it("QA-2.2-6: a switch inside the pick's own agent (a variant change) is no hint: 'prefer @medium over @medium' helps nobody", () => {
    expect(buildHint(decision({ best: choice("medium", "high"), target: target("medium", "high") }), { class: "implement" }, descriptions)).toBeNull();
  });

  it("an agent without a description is named alone; a long description or reason is cut to one line", () => {
    const plain = buildHint(decision({ target: target("general", null), best: choice("general", "default") }), { class: "debug" }, new Map())!;
    expect(plain).toContain("prefer @general over @medium.");
    const long = buildHint(decision({ reason: `${"why ".repeat(200)}\nmore` }), { class: "implement" }, new Map([["heavy", `${"x".repeat(200)}\nsecond line`]]))!;
    expect(long.split("\n")).toHaveLength(2);
    expect(long.length).toBeLessThan(400);
  });
});