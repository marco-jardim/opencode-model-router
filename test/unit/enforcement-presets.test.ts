/**
 * test/unit/enforcement-presets.test.ts
 *
 * Locks the per-mode enforcement preset examples documented in
 * docs/ENFORCEMENT_PRESETS.md: every preset must (a) pass validateConfig
 * without throwing, and (b) resolve through the runtime policy builders to the
 * values the doc promises. If a preset in the doc is edited, update it here too
 * (this test is the guard against the doc drifting into invalid/misleading
 * examples).
 */

import { describe, it, expect } from "vitest";
import { validateConfig } from "../../src/router/config";
import type { RouterConfig } from "../../src/router/config";
import { resolveEnforcementMode } from "../../src/router/enforcement";
import { buildGuardPolicy } from "../../src/guard/enforce";
import { buildEscalatePolicy } from "../../src/escalate/ladder";

// Minimal valid base config (satisfies validateConfig) the presets attach to.
const baseConfig = {
  activePreset: "anthropic",
  presets: {
    anthropic: {
      fast: { model: "anthropic/claude-haiku-4-5", description: "f", whenToUse: [] },
      medium: { model: "anthropic/claude-sonnet-4-6", description: "m", whenToUse: [] },
      heavy: { model: "anthropic/claude-opus-4-8", description: "h", whenToUse: [] },
    },
  },
  rules: [],
  defaultTier: "medium",
};

const PRESETS = {
  normal: {
    mode: "advisory",
    perTier: { fast: "advisory", medium: "enforced", heavy: "enforced" },
    guard: { budget: 25, readDraftCap: 3, sameOpRetryCap: 1, blockSelfScript: true, deliverableFirst: true },
    verify: { require: "whenDoDPresent", preferDeterministic: true, graderPolicy: "atLeastProducerTier", graderTemperature: 0 },
    escalate: { ladder: ["fast", "medium", "heavy"], maxAttemptsPerTier: 1, maxTotalAttempts: 4, costCeiling: { base: "firstAttemptCostUnits", multiple: 4 } },
    proportional: { trivialBypass: true },
  },
  budget: {
    mode: "advisory",
    perTier: { fast: "advisory", medium: "advisory", heavy: "enforced" },
    guard: { budget: 15, readDraftCap: 2, sameOpRetryCap: 1, blockSelfScript: true, deliverableFirst: true },
    verify: { require: "whenDoDPresent", preferDeterministic: true, graderTemperature: 0 },
    escalate: { ladder: ["fast", "medium", "heavy"], maxAttemptsPerTier: 1, maxTotalAttempts: 3, costCeiling: { base: "firstAttemptCostUnits", multiple: 2 } },
    proportional: { trivialBypass: true },
  },
  quality: {
    mode: "enforced",
    perTier: { fast: "enforced", medium: "enforced", heavy: "enforced" },
    guard: { budget: 30, readDraftCap: 4, sameOpRetryCap: 1, blockSelfScript: true, deliverableFirst: true },
    verify: { require: "always", preferDeterministic: true, graderPolicy: "atLeastProducerTier", minGraderTier: "medium", graderTemperature: 0 },
    escalate: { ladder: ["fast", "medium", "heavy"], maxAttemptsPerTier: 1, maxTotalAttempts: 5, costCeiling: { base: "firstAttemptCostUnits", multiple: 6 } },
    proportional: { trivialBypass: true },
  },
  deep: {
    mode: "enforced",
    perTier: { medium: "enforced", heavy: "enforced" },
    guard: { budget: 40, readDraftCap: 5, sameOpRetryCap: 1, blockSelfScript: true, deliverableFirst: true },
    verify: { require: "always", preferDeterministic: true, graderPolicy: "atLeastProducerTier", minGraderTier: "medium", graderTemperature: 0 },
    escalate: { floorTier: "medium", ladder: ["fast", "medium", "heavy"], maxAttemptsPerTier: 2, maxTotalAttempts: 6, costCeiling: { base: "firstAttemptCostUnits", multiple: 8 } },
    proportional: { trivialBypass: false },
  },
} as const;

function validated(presetName: keyof typeof PRESETS): RouterConfig {
  return validateConfig({ ...baseConfig, enforcement: PRESETS[presetName] });
}

describe("enforcement presets (docs/ENFORCEMENT_PRESETS.md)", () => {
  it("every preset passes validateConfig without throwing", () => {
    for (const name of Object.keys(PRESETS) as (keyof typeof PRESETS)[]) {
      expect(() => validated(name)).not.toThrow();
      expect(validated(name).enforcement).toBeDefined();
    }
  });

  it("normal: advisory baseline, enforced for medium/heavy; default ladder depth", () => {
    const cfg = validated("normal");
    const env: Record<string, string | undefined> = {};
    expect(resolveEnforcementMode({ config: cfg, tier: "fast", env }).mode).toBe("advisory");
    expect(resolveEnforcementMode({ config: cfg, tier: "medium", env }).mode).toBe("enforced");
    expect(resolveEnforcementMode({ config: cfg, tier: "heavy", env }).mode).toBe("enforced");
    const esc = buildEscalatePolicy(cfg);
    expect(esc.ladder).toEqual(["fast", "medium", "heavy"]);
    expect(esc.maxTotalAttempts).toBe(4);
    expect(esc.costMultiple).toBe(4);
    expect(esc.floorTier ?? null).toBeNull();
    const gp = buildGuardPolicy(cfg, "medium");
    expect(gp.budget).toBe(25);
    expect(gp.readDraftCap).toBe(3);
  });

  it("budget: shallow ladder (multiple 2), tighter caps, advisory except heavy", () => {
    const cfg = validated("budget");
    const env: Record<string, string | undefined> = {};
    expect(resolveEnforcementMode({ config: cfg, tier: "medium", env }).mode).toBe("advisory");
    expect(resolveEnforcementMode({ config: cfg, tier: "heavy", env }).mode).toBe("enforced");
    const esc = buildEscalatePolicy(cfg);
    expect(esc.maxTotalAttempts).toBe(3);
    expect(esc.costMultiple).toBe(2);
    expect(buildGuardPolicy(cfg, "fast").budget).toBe(15);
    expect(buildGuardPolicy(cfg, "fast").readDraftCap).toBe(2);
  });

  it("quality: fully enforced, deeper ladder (multiple 6, max 5)", () => {
    const cfg = validated("quality");
    const env: Record<string, string | undefined> = {};
    expect(resolveEnforcementMode({ config: cfg, tier: "fast", env }).mode).toBe("enforced");
    const esc = buildEscalatePolicy(cfg);
    expect(esc.maxTotalAttempts).toBe(5);
    expect(esc.costMultiple).toBe(6);
    expect(cfg.enforcement?.verify?.require).toBe("always");
    expect(cfg.enforcement?.verify?.minGraderTier).toBe("medium");
  });

  it("deep: floorTier medium skips cheap rungs; multiple 8; trivialBypass off", () => {
    const cfg = validated("deep");
    const esc = buildEscalatePolicy(cfg);
    expect(esc.floorTier).toBe("medium");
    expect(esc.costMultiple).toBe(8);
    expect(esc.maxAttemptsPerTier).toBe(2);
    expect(esc.maxTotalAttempts).toBe(6);
    expect(cfg.enforcement?.proportional?.trivialBypass).toBe(false);
    expect(buildGuardPolicy(cfg, "heavy").budget).toBe(40);
  });

  it("no preset enables enforcement when the env gate forces off (override)", () => {
    // Selecting a preset never overrides an explicit MODEL_ROUTER_ENFORCE=0.
    const cfg = validated("quality");
    const env = { MODEL_ROUTER_ENFORCE: "0" };
    expect(resolveEnforcementMode({ config: cfg, tier: "medium", env }).mode).toBe("off");
  });
});
