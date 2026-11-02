import { describe, expect, it } from "vitest";
import { decideAdaptive, type EvidenceRecord } from "../../src/router/adaptive";

function rec(
  model: string,
  accuracy: number,
  ci: number,
  over: Partial<EvidenceRecord> = {},
): EvidenceRecord {
  return {
    model,
    modelLabel: model,
    agent: "fixture-agent",
    agentVersion: "1.0.0",
    effort: "none",
    accuracy,
    ciHalfWidth: ci,
    nTrials: 330,
    benchmarkVersion: "4",
    sourceUrl: "https://example.test/benchmark/results.json",
    ...over,
  };
}

describe("decideAdaptive", () => {
  it("выбирает совместимого кандидата при более высоком несовместимом результате", () => {
    const decision = decideAdaptive({
      candidates: ["cand/compatible", "cand/incompatible"],
      current: {
        workstation: {
          fast: {
            model: "base/g",
            variant: "none",
          },
        },
      },
      evidence: [
        rec("base/g", 40, 5),
        rec("cand/compatible", 75, 5),
        rec("cand/incompatible", 95, 1, {
          agentVersion: "2.0.0",
        }),
      ],
      admission: {
        quotasOk: true,
        capabilitiesOk: true,
      },
    });

    expect(decision).toMatchObject({
      action: "apply",
      assignments: {
        workstation: {
          fast: {
            model: "cand/compatible",
          },
        },
      },
    });
  });

  it("сохраняет назначение при несовпадении развёрнутого variant и effort свидетельств", () => {
    const decision = decideAdaptive({
      candidates: ["cand/a"],
      current: {
        workstation: {
          fast: {
            model: "base/g",
            variant: "low",
          },
        },
      },
      evidence: [
        rec("base/g", 40, 5, { effort: "max" }),
        rec("cand/a", 80, 5, { effort: "max" }),
      ],
      admission: {
        quotasOk: true,
        capabilitiesOk: true,
      },
    });

    expect(decision.action).toBe("hold");
  });

  it("принимает улучшение с разделёнными интервалами при двадцати испытаниях", () => {
    const decision = decideAdaptive({
      candidates: ["cand/a"],
      current: {
        workstation: {
          fast: {
            model: "base/g",
            variant: "none",
          },
        },
      },
      evidence: [
        rec("base/g", 20, 20, { nTrials: 20 }),
        rec("cand/a", 80, 20, { nTrials: 20 }),
      ],
      admission: {
        quotasOk: true,
        capabilitiesOk: true,
      },
    });

    expect(decision).toMatchObject({
      action: "apply",
      assignments: {
        workstation: {
          fast: {
            model: "cand/a",
          },
        },
      },
    });
  });
});
