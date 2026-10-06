import { describe, expect, it } from "vitest";
import * as engine from "../../src/routing/engine";
import * as kernel from "../../src/routing/engine/kernel";
import * as ladders from "../../src/routing/engine/ladders";
import * as protocolLine from "../../src/routing/engine/protocol-line";
import * as plan from "../../src/routing/engine/plan";

describe("routing engine index", () => {
  it("re-exports exactly the documented surface, by identity", () => {
    expect(Object.keys(engine).sort()).toEqual(
      [
        "DEFAULT_REMAINING_TURNS",
        "GIVE_UP_COST",
        "MIN_EVIDENCE_TO_MOVE",
        "MIN_EVIDENCE_TO_SWITCH_DOWN",
        "annotateSteps",
        "buildLadder",
        "candidateKey",
        "coversNeeds",
        "decide",
        "detectionOf",
        "escalateLadder",
        "floorRankOf",
        "formatRouteLine",
        "generateTaxonomy",
        "giveUpCost",
        "hasMinEvidence",
        "grantsFromTools",
        "resolveChosen",
        "tierRankOf",
      ].sort(),
    );
    expect(engine.decide).toBe(kernel.decide);
    expect(engine.GIVE_UP_COST).toBe(kernel.GIVE_UP_COST);
    expect(engine.buildLadder).toBe(ladders.buildLadder);
    expect(engine.resolveChosen).toBe(ladders.resolveChosen);
    expect(engine.generateTaxonomy).toBe(protocolLine.generateTaxonomy);
    expect(engine.MIN_EVIDENCE_TO_MOVE).toBe(protocolLine.MIN_EVIDENCE_TO_MOVE);
    expect(engine.annotateSteps).toBe(plan.annotateSteps);
    expect(engine.formatRouteLine).toBe(plan.formatRouteLine);
  });
});
