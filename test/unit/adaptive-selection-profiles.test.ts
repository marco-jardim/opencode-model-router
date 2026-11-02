import { describe, expect, it } from "vitest";
import { decideAdaptive, type EvidenceRecord } from "../../src/router/adaptive";

function rec(
  model: string,
  accuracy: number,
  ci: number = 5,
  over: Partial<EvidenceRecord> = {},
): EvidenceRecord {
  return {
    model,
    modelLabel: model,
    agent: "fixture-agent",
    agentVersion: "1.0.0",
    effort: "high",
    accuracy,
    ciHalfWidth: ci,
    nTrials: 330,
    benchmarkVersion: "4",
    sourceUrl: "https://example.test/benchmark/results.json",
    ...over,
  };
}

describe("decideAdaptive profiles", () => {
  it("сопоставляет текущую модель и кандидатов по развёрнутому профилю", () => {
    const decision = decideAdaptive({
      candidates: ["cand/a", "cand/max"],
      current: {
        workstation: {
          fast: { model: "base/g", variant: "low" },
        },
      },
      evidence: [
        rec("base/g", 90, 5, { effort: "max" }),
        rec("base/g", 20, 5, { effort: "low" }),
        rec("cand/a", 80, 5, { effort: "low" }),
        rec("cand/max", 95, 1, { effort: "max" }),
      ],
      admission: { quotasOk: true, capabilitiesOk: true },
    });

    expect(decision).toMatchObject({
      action: "apply",
      assignments: {
        workstation: {
          fast: { model: "cand/a", variant: "low" },
        },
      },
    });
  });

  it("сохраняет variant из ссылки текущей модели", () => {
    const decision = decideAdaptive({
      candidates: ["cand/a"],
      current: {
        workstation: {
          fast: { model: "base/g#high" },
        },
      },
      evidence: [
        rec("base/g", 40),
        rec("cand/a", 80),
      ],
      admission: { quotasOk: true, capabilitiesOk: true },
    });

    expect(decision).toMatchObject({
      action: "apply",
      assignments: {
        workstation: {
          fast: { model: "cand/a", variant: "high" },
        },
      },
    });
  });

  it("сохраняет назначение при неизвестном развёрнутом variant", () => {
    const decision = decideAdaptive({
      candidates: ["cand/a"],
      current: {
        workstation: {
          fast: { model: "base/g" },
        },
      },
      evidence: [
        rec("base/g", 40, 5, { effort: "max" }),
        rec("cand/a", 80, 5, { effort: "max" }),
      ],
      admission: { quotasOk: true, capabilitiesOk: true },
    });

    expect(decision.action).toBe("hold");
  });

  it("выбирает улучшение в сопоставимой версии benchmark", () => {
    const decision = decideAdaptive({
      candidates: ["cand/other", "cand/compatible"],
      current: {
        workstation: {
          fast: { model: "base/g", variant: "high" },
        },
      },
      evidence: [
        rec("base/g", 40),
        rec("cand/other", 95, 1, { benchmarkVersion: "5" }),
        rec("cand/compatible", 80),
      ],
      admission: { quotasOk: true, capabilitiesOk: true },
    });

    expect(decision).toMatchObject({
      action: "apply",
      assignments: {
        workstation: {
          fast: { model: "cand/compatible", variant: "high" },
        },
      },
    });
  });

  it("сохраняет назначение при противоречивых свидетельствах текущего профиля", () => {
    const decision = decideAdaptive({
      candidates: ["cand/a"],
      current: {
        workstation: {
          fast: { model: "base/g", variant: "high" },
        },
      },
      evidence: [
        rec("base/g", 20),
        rec("base/g", 90),
        rec("cand/a", 70),
      ],
      admission: { quotasOk: true, capabilitiesOk: true },
    });

    expect(decision.action).toBe("hold");
  });

  it("сохраняет назначение при соприкасающихся доверительных интервалах", () => {
    const decision = decideAdaptive({
      candidates: ["cand/a"],
      current: {
        workstation: {
          fast: { model: "base/g", variant: "high" },
        },
      },
      evidence: [
        rec("base/g", 40),
        rec("cand/a", 50),
      ],
      admission: { quotasOk: true, capabilitiesOk: true },
    });

    expect(decision.action).toBe("hold");
  });
});
