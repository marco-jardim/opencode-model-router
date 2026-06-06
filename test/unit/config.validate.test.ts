import { describe, it, expect } from "vitest";
import {
  validateConfig,
  normalizeEnforcement,
  resolvePresetName,
  type RouterConfig,
} from "../../src/router/config";

/** Build a minimal valid raw config object; merge `extra` to override/add keys. */
function validRaw(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    activePreset: "anthropic",
    presets: {
      anthropic: {
        fast: {
          model: "anthropic/claude-haiku-4-5",
          description: "fast tier",
          whenToUse: ["recon"],
        },
      },
    },
    rules: ["r1"],
    defaultTier: "fast",
    ...extra,
  };
}

describe("validateConfig — happy path", () => {
  it("accepts a minimal valid config and leaves enforcement undefined when absent", () => {
    const cfg = validateConfig(validRaw());
    expect(cfg.activePreset).toBe("anthropic");
    expect(cfg.enforcement).toBeUndefined();
  });

  it("accepts optional blocks (modes, tierCaps, tierPrompts, taskPatterns) when well-formed", () => {
    const cfg = validateConfig(
      validRaw({
        modes: { budget: { defaultTier: "fast", description: "cheap" } },
        tierCaps: { fast: 3, medium: 5 },
        tierPrompts: { fast: "be terse" },
        taskPatterns: { fast: ["recon", "lookup"] },
      }),
    );
    expect(cfg.tierCaps?.fast).toBe(3);
  });
});

describe("validateConfig — root shape", () => {
  it.each([
    ["null", null],
    ["a string", "nope"],
    ["a number", 5],
    ["undefined", undefined],
  ])("throws when root is %s", (_label, raw) => {
    expect(() => validateConfig(raw)).toThrow();
  });

  it("throws on empty/missing activePreset", () => {
    expect(() => validateConfig(validRaw({ activePreset: "" }))).toThrow(/activePreset/);
    expect(() => validateConfig(validRaw({ activePreset: 1 }))).toThrow(/activePreset/);
  });

  it("throws when presets is not a non-null object", () => {
    expect(() => validateConfig(validRaw({ presets: null }))).toThrow(/presets/);
    expect(() => validateConfig(validRaw({ presets: [] }))).toThrow(/presets/);
  });

  it("throws when a preset is not an object", () => {
    expect(() => validateConfig(validRaw({ presets: { anthropic: 7 } }))).toThrow(/preset 'anthropic'/);
  });

  it("throws when rules is not an array", () => {
    expect(() => validateConfig(validRaw({ rules: "x" }))).toThrow(/rules/);
  });

  it("throws when defaultTier is not a string", () => {
    expect(() => validateConfig(validRaw({ defaultTier: 3 }))).toThrow(/defaultTier/);
  });
});

describe("validateConfig — tier shape", () => {
  function withTier(tier: unknown) {
    return validRaw({ presets: { anthropic: { fast: tier } } });
  }
  it("throws when a tier is not an object", () => {
    expect(() => validateConfig(withTier(null))).toThrow(/must be an object/);
  });
  it("throws when tier.model is missing/empty", () => {
    expect(() => validateConfig(withTier({ description: "d", whenToUse: [] }))).toThrow(/\.model/);
    expect(() => validateConfig(withTier({ model: "", description: "d", whenToUse: [] }))).toThrow(/\.model/);
  });
  it("throws when tier.description is not a string", () => {
    expect(() => validateConfig(withTier({ model: "m", description: 1, whenToUse: [] }))).toThrow(/\.description/);
  });
  it("throws when tier.whenToUse is not an array", () => {
    expect(() => validateConfig(withTier({ model: "m", description: "d", whenToUse: "x" }))).toThrow(/whenToUse/);
  });
});

describe("validateConfig — modes block", () => {
  it("throws when modes is not an object", () => {
    expect(() => validateConfig(validRaw({ modes: [] }))).toThrow(/modes/);
  });
  it("throws when a mode is not an object", () => {
    expect(() => validateConfig(validRaw({ modes: { budget: 1 } }))).toThrow(/mode 'budget'/);
  });
  it("throws when mode.defaultTier / mode.description are wrong type", () => {
    expect(() => validateConfig(validRaw({ modes: { budget: { description: "x" } } }))).toThrow(/defaultTier/);
    expect(() => validateConfig(validRaw({ modes: { budget: { defaultTier: "fast" } } }))).toThrow(/description/);
  });
});

describe("validateConfig — tierCaps / tierPrompts / taskPatterns", () => {
  it("throws when tierCaps is not an object", () => {
    expect(() => validateConfig(validRaw({ tierCaps: [] }))).toThrow(/tierCaps/);
  });
  it("throws when a tierCaps value is non-number or < 1", () => {
    expect(() => validateConfig(validRaw({ tierCaps: { fast: "8" } }))).toThrow(/positive integer/);
    expect(() => validateConfig(validRaw({ tierCaps: { fast: 0 } }))).toThrow(/positive integer/);
  });
  it("throws when tierPrompts is not an object or a value is non-string", () => {
    expect(() => validateConfig(validRaw({ tierPrompts: [] }))).toThrow(/tierPrompts/);
    expect(() => validateConfig(validRaw({ tierPrompts: { fast: 1 } }))).toThrow(/tierPrompts/);
  });
  it("throws when taskPatterns is not an object or a value is non-array", () => {
    expect(() => validateConfig(validRaw({ taskPatterns: [] }))).toThrow(/taskPatterns/);
    expect(() => validateConfig(validRaw({ taskPatterns: { fast: "x" } }))).toThrow(/taskPatterns/);
  });
});

describe("validateConfig — enforcement block", () => {
  function withEnf(enf: unknown) {
    return validRaw({ enforcement: enf });
  }
  it("throws when enforcement is not an object", () => {
    expect(() => validateConfig(withEnf("x"))).toThrow(/enforcement must be an object/);
    expect(() => validateConfig(withEnf([]))).toThrow(/enforcement must be an object/);
  });
  it("accepts valid enforcement.mode values; rejects invalid", () => {
    for (const mode of ["off", "advisory", "enforced"]) {
      expect(validateConfig(withEnf({ mode })).enforcement?.mode).toBe(mode);
    }
    expect(() => validateConfig(withEnf({ mode: "loud" }))).toThrow(/enforcement.mode/);
  });
  it("enforces verify.graderPolicy === atLeastProducerTier", () => {
    expect(() => validateConfig(withEnf({ verify: { graderPolicy: "cheapest" } }))).toThrow(/graderPolicy/);
    expect(validateConfig(withEnf({ verify: { graderPolicy: "atLeastProducerTier" } })).enforcement).toBeDefined();
  });
  it("rejects costCeiling.multiple <= 0; accepts > 0", () => {
    expect(() => validateConfig(withEnf({ escalate: { costCeiling: { multiple: 0 } } }))).toThrow(/multiple must be a number/);
    expect(() => validateConfig(withEnf({ escalate: { costCeiling: { multiple: -1 } } }))).toThrow(/multiple must be a number/);
    expect(() => validateConfig(withEnf({ escalate: { costCeiling: { multiple: "4" } } }))).toThrow(/multiple must be a number/);
    expect(validateConfig(withEnf({ escalate: { costCeiling: { multiple: 4 } } })).enforcement).toBeDefined();
  });
  it("rejects non-string-array ladder; accepts string[]", () => {
    expect(() => validateConfig(withEnf({ escalate: { ladder: "fast" } }))).toThrow(/ladder/);
    expect(() => validateConfig(withEnf({ escalate: { ladder: [1, 2] } }))).toThrow(/ladder/);
    expect(validateConfig(withEnf({ escalate: { ladder: ["fast", "medium"] } })).enforcement).toBeDefined();
  });
  it("rejects invalid perTier values; accepts enum values", () => {
    expect(() => validateConfig(withEnf({ perTier: { fast: "loud" } }))).toThrow(/perTier.fast/);
    expect(validateConfig(withEnf({ perTier: { fast: "advisory", heavy: "enforced" } })).enforcement).toBeDefined();
  });

  // --- Documented permissive gaps: these sub-blocks are validated ONLY when they
  // are themselves objects/arrays. Non-object shapes are silently ignored (no throw).
  // These assertions pin CURRENT behaviour so a future tightening is a conscious change.
  it("does NOT throw when verify/escalate/perTier are non-objects (permissive skip)", () => {
    expect(() => validateConfig(withEnf({ verify: "x" }))).not.toThrow();
    expect(() => validateConfig(withEnf({ escalate: "x" }))).not.toThrow();
    expect(() => validateConfig(withEnf({ perTier: "x" }))).not.toThrow();
    expect(() => validateConfig(withEnf({ escalate: { costCeiling: "x" } }))).not.toThrow();
  });
});

describe("validateConfig — enforcement.escalate extra fields", () => {
  function withEnf(enf: unknown) {
    return validRaw({ enforcement: enf });
  }

  it("accepts valid {maxAttemptsPerTier:0, maxTotalAttempts:1, floorTier:null}", () => {
    expect(() =>
      validateConfig(withEnf({ escalate: { maxAttemptsPerTier: 0, maxTotalAttempts: 1, floorTier: null } })),
    ).not.toThrow();
  });

  it("accepts valid floorTier:'medium'", () => {
    expect(() =>
      validateConfig(withEnf({ escalate: { floorTier: "medium" } })),
    ).not.toThrow();
  });

  it("throws when maxAttemptsPerTier is -1", () => {
    expect(() =>
      validateConfig(withEnf({ escalate: { maxAttemptsPerTier: -1 } })),
    ).toThrow("enforcement.escalate.maxAttemptsPerTier must be an integer >= 0");
  });

  it("throws when maxAttemptsPerTier is 1.5 (non-integer)", () => {
    expect(() =>
      validateConfig(withEnf({ escalate: { maxAttemptsPerTier: 1.5 } })),
    ).toThrow("enforcement.escalate.maxAttemptsPerTier must be an integer >= 0");
  });

  it("throws when maxTotalAttempts is 0", () => {
    expect(() =>
      validateConfig(withEnf({ escalate: { maxTotalAttempts: 0 } })),
    ).toThrow("enforcement.escalate.maxTotalAttempts must be an integer >= 1");
  });

  it("throws when floorTier is 123 (number, not string or null)", () => {
    expect(() =>
      validateConfig(withEnf({ escalate: { floorTier: 123 } })),
    ).toThrow("enforcement.escalate.floorTier must be a string or null");
  });
});

describe("normalizeEnforcement", () => {
  it("missing enforcement ⇒ mode:off", () => {
    expect(normalizeEnforcement(undefined)).toEqual({ mode: "off" });
    expect(normalizeEnforcement({})).toEqual({ mode: "off" });
  });
  it("passes through an explicit mode", () => {
    expect(normalizeEnforcement({ mode: "enforced" })).toEqual({ mode: "enforced" });
    expect(normalizeEnforcement({ mode: "advisory" })).toEqual({ mode: "advisory" });
  });
});

describe("resolvePresetName", () => {
  const cfg = { presets: { anthropic: {}, "github-copilot": {} } } as unknown as RouterConfig;
  it("returns exact match", () => {
    expect(resolvePresetName(cfg, "anthropic")).toBe("anthropic");
  });
  it("matches case-insensitively", () => {
    expect(resolvePresetName(cfg, "ANTHROPIC")).toBe("anthropic");
    expect(resolvePresetName(cfg, "GitHub-Copilot")).toBe("github-copilot");
  });
  it("returns undefined for empty or unknown names", () => {
    expect(resolvePresetName(cfg, "   ")).toBeUndefined();
    expect(resolvePresetName(cfg, "openai")).toBeUndefined();
  });
});

describe("validateConfig — enforcement.guard validation", () => {
  function withEnf(enf: unknown) {
    return validRaw({ enforcement: enf });
  }

  it("accepts guard.budget=12 (valid positive number)", () => {
    expect(() => validateConfig(withEnf({ guard: { budget: 12 } }))).not.toThrow();
  });

  it("accepts guard.budget=1 (minimum boundary)", () => {
    expect(() => validateConfig(withEnf({ guard: { budget: 1 } }))).not.toThrow();
  });

  it("throws when guard.budget=0 (below minimum)", () => {
    expect(() => validateConfig(withEnf({ guard: { budget: 0 } }))).toThrow(
      "enforcement.guard.budget must be a number >= 1",
    );
  });

  it("throws when guard.budget is a string", () => {
    expect(() => validateConfig(withEnf({ guard: { budget: "x" } }))).toThrow(
      "enforcement.guard.budget must be a number >= 1",
    );
  });

  it("throws when guard.budget is Infinity", () => {
    expect(() => validateConfig(withEnf({ guard: { budget: Infinity } }))).toThrow(
      "enforcement.guard.budget must be a number >= 1",
    );
  });

  it("accepts guard.blockScriptWrites=true (valid boolean)", () => {
    expect(() =>
      validateConfig(withEnf({ guard: { blockScriptWrites: true } })),
    ).not.toThrow();
  });

  it("accepts guard.blockScriptWrites=false (valid boolean)", () => {
    expect(() =>
      validateConfig(withEnf({ guard: { blockScriptWrites: false } })),
    ).not.toThrow();
  });

  it('throws when guard.blockScriptWrites="yes" (string, not boolean)', () => {
    expect(() =>
      validateConfig(withEnf({ guard: { blockScriptWrites: "yes" } })),
    ).toThrow("enforcement.guard.blockScriptWrites must be a boolean");
  });

  it("accepts guard absent — no validation performed", () => {
    expect(() => validateConfig(withEnf({ mode: "enforced" }))).not.toThrow();
  });

  it("accepts guard with both valid fields together", () => {
    expect(() =>
      validateConfig(withEnf({ guard: { budget: 20, blockScriptWrites: true } })),
    ).not.toThrow();
  });
});