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
  it("accepts antiNarration boolean, rejects non-boolean", () => {
    expect(() => validateConfig(validRaw({ antiNarration: true }))).not.toThrow();
    expect(() => validateConfig(validRaw({ antiNarration: "yes" }))).toThrow(/antiNarration/);
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
    expect(() => validateConfig(withTier({ model: "provider/m", description: 1, whenToUse: [] }))).toThrow(/\.description/);
  });
  it("throws when tier.whenToUse is not an array", () => {
    expect(() => validateConfig(withTier({ model: "provider/m", description: "d", whenToUse: "x" }))).toThrow(/whenToUse/);
  });
  it("accepts a tier with only `model` (description/whenToUse optional)", () => {
    expect(() => validateConfig(withTier({ model: "provider/m" }))).not.toThrow();
  });

  // Reported in #17: a malformed ref used to load clean and only surface as a
  // catalog issue on some later turn, or never if the catalog fetch failed.
  // The shape needs no network, so it is decided at load.
  it("throws when tier.model has no provider", () => {
    expect(() => validateConfig(withTier({ model: "claude-sonnet-5" }))).toThrow(
      "tiers.json: 'anthropic.fast.model' must be 'provider/model' (got 'claude-sonnet-5')",
    );
  });
  it("throws when tier.model has an empty provider or an empty model", () => {
    expect(() => validateConfig(withTier({ model: "/claude-sonnet-5" }))).toThrow(/'provider\/model'/);
    expect(() => validateConfig(withTier({ model: "anthropic/" }))).toThrow(/'provider\/model'/);
    expect(() => validateConfig(withTier({ model: "/" }))).toThrow(/'provider\/model'/);
  });
  // Multi-segment model ids are legal: the split takes the FIRST slash only, so
  // the provider is `openrouter` and the model keeps its remaining slashes.
  it("accepts a multi-segment model id", () => {
    expect(() =>
      validateConfig(withTier({ model: "openrouter/deepseek/deepseek-v3.2" })),
    ).not.toThrow();
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
  it.each([null, {}, "x", [1], [""], ["noslash"], ["/m"], ["p/"]].map(value => ({ value })))(
    "rejects invalid graderTemperatureModels: $value", ({ value }) => {
      expect(() => validateConfig(withEnf({ verify: { graderTemperatureModels: value } })))
        .toThrow("tiers.json: enforcement.verify.graderTemperatureModels");
    },
  );
  it.each([[], ["openai/gpt-x"], ["openai/org/model"]].map(value => ({ value })))(
    "accepts graderTemperatureModels: $value", ({ value }) => {
      expect(validateConfig(withEnf({ verify: { graderTemperatureModels: value } })).enforcement?.verify?.graderTemperatureModels)
        .toEqual(value);
    },
  );
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
  it("throws when verify is a non-object (tightened by QA-1.1-1)", () => {
    for (const bad of ["x", null, 5, []]) {
      expect(() => validateConfig(withEnf({ verify: bad }))).toThrow(
        "tiers.json: enforcement.verify must be an object",
      );
    }
  });
  it("does NOT throw when escalate/perTier are non-objects (permissive skip)", () => {
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
  it("missing enforcement ⇒ mode:advisory", () => {
    expect(normalizeEnforcement(undefined)).toEqual({ mode: "advisory" });
    expect(normalizeEnforcement({})).toEqual({ mode: "advisory" });
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
      "tiers.json: enforcement.guard.budget must be a number >= 1",
    );
  });

  it("throws when guard.budget is a string", () => {
    expect(() => validateConfig(withEnf({ guard: { budget: "x" } }))).toThrow(
      "tiers.json: enforcement.guard.budget must be a number >= 1",
    );
  });

  it("throws when guard.budget is Infinity", () => {
    expect(() => validateConfig(withEnf({ guard: { budget: Infinity } }))).toThrow(
      "tiers.json: enforcement.guard.budget must be a number >= 1",
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
    ).toThrow("tiers.json: enforcement.guard.blockScriptWrites must be a boolean");
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

describe("validateConfig — subagentTiers", () => {
  it("accepts the key being absent", () => {
    expect(() => validateConfig(validRaw())).not.toThrow();
  });

  it("accepts a well-formed map", () => {
    expect(() =>
      validateConfig(validRaw({ subagentTiers: { ContextScout: "fast" } })),
    ).not.toThrow();
  });

  it("accepts a tier name no preset defines — skipped at resolve time, never fatal", () => {
    expect(() =>
      validateConfig(validRaw({ subagentTiers: { ContextScout: "ultra" } })),
    ).not.toThrow();
  });

  it("throws when subagentTiers is not an object", () => {
    expect(() => validateConfig(validRaw({ subagentTiers: "fast" }))).toThrow(
      "'subagentTiers' must be an object",
    );
  });

  it("throws when a value is not a string", () => {
    expect(() =>
      validateConfig(validRaw({ subagentTiers: { ContextScout: 1 } })),
    ).toThrow("subagentTiers.'ContextScout' must be a non-empty tier name");
  });

  it("throws when a value is an empty string", () => {
    expect(() =>
      validateConfig(validRaw({ subagentTiers: { ContextScout: "" } })),
    ).toThrow("subagentTiers.'ContextScout' must be a non-empty tier name");
  });
});

// ---------------------------------------------------------------------------
// Cost-aware routing (#74, Phase 1.1): `routing`, `tiers.<t>.candidates`,
// `enforcement.escalate.variantSteps`.
// ---------------------------------------------------------------------------

/** A raw config carrying the given `routing` block. */
function withRouting(routing: unknown): Record<string, unknown> {
  return validRaw({ routing });
}

/** A raw config whose only tier is `fast` (`anthropic/claude-haiku-4-5`) with the given candidates. */
function withCandidates(candidates: unknown): Record<string, unknown> {
  return validRaw({
    presets: {
      anthropic: {
        fast: { model: "anthropic/claude-haiku-4-5", candidates },
      },
    },
  });
}

describe("validateConfig — routing: shape and unknown keys", () => {
  it("leaves a config without a routing block untouched (same object, no routing)", () => {
    const raw = validRaw();
    const cfg = validateConfig(raw);
    expect(cfg).toBe(raw);
    expect(cfg.routing).toBeUndefined();
  });

  it("accepts an empty routing block", () => {
    expect(validateConfig(withRouting({})).routing).toEqual({});
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "enforce"],
    ["a number", 1],
  ])("rejects routing being %s", (_label, value) => {
    expect(() => validateConfig(withRouting(value))).toThrow(/'routing' must be an object/);
  });

  it("ignores unknown keys, like every other block of the file, and drops them from the snapshot", () => {
    const cfg = validateConfig(
      withRouting({ engine: "shadow", futureKnob: 1, classifier: { backend: "rules", futureKnob: true } }),
    );
    expect(cfg.routing).toEqual({ engine: "shadow", classifier: { backend: "rules" } });
  });

  it("rejects prototype-reparenting keys at every level", () => {
    for (const text of [
      '{"__proto__": {"engine": "enforce"}}',
      '{"classifier": {"__proto__": {}}}',
      '{"roles": {"__proto__": ["x"]}}',
      '{"detection": {"constructor": 1}}',
    ]) {
      expect(() => validateConfig(withRouting(JSON.parse(text)))).toThrow(/must not contain the key/);
    }
  });

  it("reads every value once: a getter that changes after validation cannot slip a bad value in", () => {
    let reads = 0;
    const routing = {
      get margin(): number {
        reads += 1;
        return reads === 1 ? 0.5 : 5;
      },
    };
    const cfg = validateConfig(withRouting(routing));
    expect(cfg.routing?.margin).toBe(0.5);
    expect(cfg.routing?.margin).toBe(0.5);
    expect(reads).toBe(1);
  });
});

describe("validateConfig — routing: enums and scalars", () => {
  it.each(["static", "shadow", "advise", "enforce"])("accepts engine %s", (engine) => {
    expect(validateConfig(withRouting({ engine })).routing?.engine).toBe(engine);
  });

  it.each(["turbo", "", "ENFORCE", 1, null])("rejects engine %j", (engine) => {
    expect(() => validateConfig(withRouting({ engine }))).toThrow(
      /routing\.engine must be one of static\|shadow\|advise\|enforce/,
    );
  });

  it.each(["frugal", "balanced", "safe"])("accepts profile %s", (profile) => {
    expect(validateConfig(withRouting({ profile })).routing?.profile).toBe(profile);
  });

  it("rejects an unknown profile", () => {
    expect(() => validateConfig(withRouting({ profile: "reckless" }))).toThrow(
      /routing\.profile must be one of frugal\|balanced\|safe/,
    );
  });

  it.each([0, 0.2, 0.9])("accepts margin %s", (margin) => {
    expect(validateConfig(withRouting({ margin })).routing?.margin).toBe(margin);
  });

  it.each([-0.01, 0.91, 1, "0.2", null, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects margin %j",
    (margin) => {
      expect(() => validateConfig(withRouting({ margin }))).toThrow(/routing\.margin must be a number >= 0 and <= 0.9/);
    },
  );

  it("accepts margin 0.9 with profile safe (the extreme pair is a valid config)", () => {
    expect(() => validateConfig(withRouting({ margin: 0.9, profile: "safe" }))).not.toThrow();
  });

  it.each([0, 0.7, 1])("accepts minClassConfidence %s", (minClassConfidence) => {
    expect(validateConfig(withRouting({ minClassConfidence })).routing?.minClassConfidence).toBe(minClassConfidence);
  });

  it.each([-0.1, 1.01, "0.7", null])("rejects minClassConfidence %j", (minClassConfidence) => {
    expect(() => validateConfig(withRouting({ minClassConfidence }))).toThrow(
      /routing\.minClassConfidence must be a number >= 0 and <= 1/,
    );
  });
});

describe("validateConfig — routing.detection", () => {
  it("accepts 0 and 1 for every key", () => {
    expect(
      validateConfig(withRouting({ detection: { deterministic: 1, grader: 0.5, none: 0 } })).routing?.detection,
    ).toEqual({ deterministic: 1, grader: 0.5, none: 0 });
  });

  it.each(["deterministic", "grader", "none"])("rejects %s outside [0, 1]", (key) => {
    expect(() => validateConfig(withRouting({ detection: { [key]: 1.1 } }))).toThrow(
      new RegExp(`routing\\.detection\\.${key} must be a number >= 0 and <= 1`),
    );
    expect(() => validateConfig(withRouting({ detection: { [key]: -0.1 } }))).toThrow(
      new RegExp(`routing\\.detection\\.${key}`),
    );
  });

  it("rejects detection that is not an object", () => {
    expect(() => validateConfig(withRouting({ detection: 0.9 }))).toThrow(/routing\.detection must be an object/);
    expect(() => validateConfig(withRouting({ detection: null }))).toThrow(/routing\.detection must be an object/);
  });
});

describe("validateConfig — routing.classifier", () => {
  it.each(["rules", "host", "openai-compatible", "typesafe"])("accepts backend %s (with what it needs)", (backend) => {
    const classifier: Record<string, unknown> = { backend };
    if (backend !== "rules") classifier.model = "opencode-go/deepseek-v4.1-flash";
    if (backend === "openai-compatible" || backend === "typesafe") classifier.baseUrl = "https://llm.example/v1";
    expect(validateConfig(withRouting({ classifier })).routing?.classifier?.backend).toBe(backend);
  });

  it("rejects an unknown backend", () => {
    expect(() => validateConfig(withRouting({ classifier: { backend: "magic" } }))).toThrow(
      /routing\.classifier\.backend must be one of rules\|host\|openai-compatible\|typesafe/,
    );
  });

  it('accepts the DF3 live-check shape: backend "host" + a catalog model + timeoutMs 10000 (phase 0.P handoff)', () => {
    const cfg = validateConfig(
      withRouting({
        classifier: { backend: "host", model: "opencode-go/deepseek-v4.1-flash", timeoutMs: 10000 },
      }),
    );
    expect(cfg.routing?.classifier).toEqual({
      backend: "host",
      model: "opencode-go/deepseek-v4.1-flash",
      timeoutMs: 10000,
    });
  });

  it.each(["host", "openai-compatible", "typesafe"])(
    "rejects backend %s without a model, naming routing.classifier.model (D3)",
    (backend) => {
      expect(() =>
        validateConfig(withRouting({ classifier: { backend, baseUrl: "https://llm.example/v1" } })),
      ).toThrow(/routing\.classifier\.model must be a non-empty 'provider\/model\[#variant\]' string/);
    },
  );

  it.each([null, ""])("rejects backend host with model %j", (model) => {
    expect(() => validateConfig(withRouting({ classifier: { backend: "host", model } }))).toThrow(
      /routing\.classifier\.model/,
    );
  });

  it("accepts a rules classifier with no model, with a null model, and with a model that is not used", () => {
    expect(() => validateConfig(withRouting({ classifier: { backend: "rules" } }))).not.toThrow();
    expect(() => validateConfig(withRouting({ classifier: { model: null } }))).not.toThrow();
    expect(() => validateConfig(withRouting({ classifier: { model: "openai/gpt-6-luna" } }))).not.toThrow();
  });

  it.each(["gpt", "/gpt", "openai/", "openai/gpt#", "openai/gpt#a b", "openai/gpt#a#b", 5])(
    "rejects malformed model %j",
    (model) => {
      expect(() => validateConfig(withRouting({ classifier: { backend: "host", model } }))).toThrow(
        /routing\.classifier\.model must be null or a 'provider\/model\[#variant\]' string/,
      );
    },
  );

  it.each(["openai/gpt-6-luna", "openai/gpt-6-luna#high", "openrouter/deepseek/deepseek-v3.2#low"])(
    "accepts model %s",
    (model) => {
      expect(() => validateConfig(withRouting({ classifier: { backend: "host", model } }))).not.toThrow();
    },
  );

  it.each(["openai-compatible", "typesafe"])("requires an http(s) baseUrl for %s", (backend) => {
    const base = { backend, model: "local/qwen" };
    expect(() => validateConfig(withRouting({ classifier: base }))).toThrow(
      new RegExp(`routing\\.classifier\\.baseUrl must be an http\\(s\\) URL when routing\\.classifier\\.backend is "${backend}"`),
    );
    expect(() => validateConfig(withRouting({ classifier: { ...base, baseUrl: null } }))).toThrow(/baseUrl/);
    for (const baseUrl of ["ftp://x.example", "not a url", "localhost:8080", 8080]) {
      expect(() => validateConfig(withRouting({ classifier: { ...base, baseUrl } }))).toThrow(
        /routing\.classifier\.baseUrl must be null or an http\(s\) URL/,
      );
    }
    for (const baseUrl of ["http://localhost:11434/v1", "https://llm.example/v1"]) {
      expect(() => validateConfig(withRouting({ classifier: { ...base, baseUrl } }))).not.toThrow();
    }
  });

  it("does not require a baseUrl for host, but still validates one that is set", () => {
    expect(() =>
      validateConfig(withRouting({ classifier: { backend: "host", model: "a/b", baseUrl: null } })),
    ).not.toThrow();
    expect(() =>
      validateConfig(withRouting({ classifier: { backend: "host", model: "a/b", baseUrl: "ftp://x" } })),
    ).toThrow(/baseUrl/);
  });

  it("validates apiKeyEnv as an environment variable name or null", () => {
    expect(() => validateConfig(withRouting({ classifier: { apiKeyEnv: "OMR_CLASSIFIER_KEY" } }))).not.toThrow();
    expect(() => validateConfig(withRouting({ classifier: { apiKeyEnv: null } }))).not.toThrow();
    for (const apiKeyEnv of ["", "has space", "1ABC", "A-B", 7]) {
      expect(() => validateConfig(withRouting({ classifier: { apiKeyEnv } }))).toThrow(
        /routing\.classifier\.apiKeyEnv must be null or an environment variable name/,
      );
    }
  });

  it.each([100, 1500, 30000])("accepts timeoutMs %s", (timeoutMs) => {
    expect(validateConfig(withRouting({ classifier: { timeoutMs } })).routing?.classifier?.timeoutMs).toBe(timeoutMs);
  });

  it.each([99, 30001, 0, -5, 1500.5, "1500", null])("rejects timeoutMs %j", (timeoutMs) => {
    expect(() => validateConfig(withRouting({ classifier: { timeoutMs } }))).toThrow(
      /routing\.classifier\.timeoutMs must be an integer >= 100 and <= 30000/,
    );
  });

  it.each([1, 3])("accepts samples %s", (samples) => {
    expect(validateConfig(withRouting({ classifier: { samples } })).routing?.classifier?.samples).toBe(samples);
  });

  it.each([0, 2, 4, "1", null])("rejects samples %j", (samples) => {
    expect(() => validateConfig(withRouting({ classifier: { samples } }))).toThrow(
      /routing\.classifier\.samples must be 1 or 3/,
    );
  });

  it.each([200, 2000, 20000])("accepts maxStateChars %s", (maxStateChars) => {
    expect(validateConfig(withRouting({ classifier: { maxStateChars } })).routing?.classifier?.maxStateChars).toBe(
      maxStateChars,
    );
  });

  it.each([199, 20001, 2000.5, "2000"])("rejects maxStateChars %j", (maxStateChars) => {
    expect(() => validateConfig(withRouting({ classifier: { maxStateChars } }))).toThrow(
      /routing\.classifier\.maxStateChars must be an integer >= 200 and <= 20000/,
    );
  });

  it("rejects classifier that is not an object", () => {
    expect(() => validateConfig(withRouting({ classifier: "host" }))).toThrow(/routing\.classifier must be an object/);
  });

  describe("per-preset overrides", () => {
    it("accepts overrides of model and backend", () => {
      const cfg = validateConfig(
        withRouting({
          classifier: {
            backend: "host",
            model: "opencode-go/deepseek-v4.1-flash",
            presets: {
              anthropic: { model: "opencode-go/gpt-6-luna" },
              local: { backend: "rules" },
              cleared: { model: null, backend: "rules" },
            },
          },
        }),
      );
      expect(cfg.routing?.classifier?.presets).toEqual({
        anthropic: { model: "opencode-go/gpt-6-luna" },
        local: { backend: "rules" },
        cleared: { model: null, backend: "rules" },
      });
    });

    it("accepts a preset name that no preset defines (switching presets must never brick startup)", () => {
      expect(() =>
        validateConfig(withRouting({ classifier: { presets: { "no-such-preset": { backend: "rules" } } } })),
      ).not.toThrow();
    });

    it("rejects an override that resolves to a model-less backend, naming both keys", () => {
      expect(() =>
        validateConfig(withRouting({ classifier: { presets: { anthropic: { backend: "host" } } } })),
      ).toThrow(/routing\.classifier\.model or routing\.classifier\.presets\.'anthropic'\.model must be a non-empty/);
    });

    it("rejects an override that clears the model of a model-backed classifier", () => {
      expect(() =>
        validateConfig(
          withRouting({
            classifier: { backend: "host", model: "a/b", presets: { anthropic: { model: null } } },
          }),
        ),
      ).toThrow(/presets\.'anthropic'/);
    });

    it("rejects an override that switches to an HTTP backend without a baseUrl", () => {
      expect(() =>
        validateConfig(
          withRouting({
            classifier: { model: "a/b", presets: { anthropic: { backend: "openai-compatible" } } },
          }),
        ),
      ).toThrow(/routing\.classifier\.baseUrl must be an http\(s\) URL/);
    });

    it.each([
      ["a string", "host"],
      ["null", null],
      ["an array", []],
    ])("rejects an entry that is %s", (_label, entry) => {
      expect(() => validateConfig(withRouting({ classifier: { presets: { anthropic: entry } } }))).toThrow(
        /routing\.classifier\.presets\.'anthropic' must be an object/,
      );
    });

    it("rejects an unknown backend and a malformed model in an entry", () => {
      expect(() =>
        validateConfig(withRouting({ classifier: { presets: { anthropic: { backend: "magic" } } } })),
      ).toThrow(/presets\.'anthropic'\.backend must be one of/);
      expect(() =>
        validateConfig(withRouting({ classifier: { presets: { anthropic: { model: "nope" } } } })),
      ).toThrow(/presets\.'anthropic'\.model must be null or/);
    });
  });
});

describe("validateConfig — routing.roles", () => {
  it("accepts the documented default shape and {}", () => {
    const roles = { search: ["explore"], implement: ["general"], debug: ["general"], review: ["general"] };
    expect(validateConfig(withRouting({ roles })).routing?.roles).toEqual(roles);
    expect(validateConfig(withRouting({ roles: {} })).routing?.roles).toEqual({});
  });

  it("accepts agents the active preset does not define (roles may name native agents)", () => {
    expect(() =>
      validateConfig(withRouting({ roles: { search: ["explore", "my-custom_agent2"] } })),
    ).not.toThrow();
  });

  it("copies the arrays, so the snapshot never aliases the input", () => {
    const input = ["explore"];
    const cfg = validateConfig(withRouting({ roles: { search: input } }));
    expect(cfg.routing?.roles?.search).toEqual(["explore"]);
    expect(cfg.routing?.roles?.search).not.toBe(input);
  });

  it.each([
    ["an empty array", []],
    ["a string", "explore"],
    ["null", null],
    ["an object", { 0: "explore" }],
  ])("rejects a class whose value is %s", (_label, agents) => {
    expect(() => validateConfig(withRouting({ roles: { search: agents } }))).toThrow(
      /routing\.roles\.'search' must be a non-empty array of agent ids/,
    );
  });

  it.each([["empty string", ""], ["uppercase", "Explore"], ["space", "my agent"], ["slash", "a/b"], ["number", 3], ["null", null]])(
    "rejects an agent id that is %s",
    (_label, agent) => {
      expect(() => validateConfig(withRouting({ roles: { search: ["explore", agent] } }))).toThrow(
        /routing\.roles\.'search' entries must be agent ids matching \^\[a-z0-9_-\]\+\$/,
      );
    },
  );

  it("rejects a class key that is not an id", () => {
    expect(() => validateConfig(withRouting({ roles: { "": ["explore"] } }))).toThrow(/routing\.roles class ''/);
    expect(() => validateConfig(withRouting({ roles: { "Bad Class": ["explore"] } }))).toThrow(
      /routing\.roles class 'Bad Class'/,
    );
  });

  it("rejects roles that is not an object", () => {
    expect(() => validateConfig(withRouting({ roles: ["explore"] }))).toThrow(/routing\.roles must be an object/);
    expect(() => validateConfig(withRouting({ roles: null }))).toThrow(/routing\.roles must be an object/);
  });
});

describe("validateConfig — routing.outcomes / sessionReuse / advisor", () => {
  it.each([1, 14, 365])("accepts outcomes.halfLifeDays %s", (halfLifeDays) => {
    expect(validateConfig(withRouting({ outcomes: { halfLifeDays } })).routing?.outcomes?.halfLifeDays).toBe(halfLifeDays);
  });

  it.each([0.5, 0, 366, "14", null])("rejects outcomes.halfLifeDays %j", (halfLifeDays) => {
    expect(() => validateConfig(withRouting({ outcomes: { halfLifeDays } }))).toThrow(
      /routing\.outcomes\.halfLifeDays must be a number >= 1 and <= 365/,
    );
  });

  it.each([5, 50, 1000])("accepts outcomes.maxEffectiveSamples %s", (maxEffectiveSamples) => {
    expect(
      validateConfig(withRouting({ outcomes: { maxEffectiveSamples } })).routing?.outcomes?.maxEffectiveSamples,
    ).toBe(maxEffectiveSamples);
  });

  it.each([4, 1001, 0, "50"])("rejects outcomes.maxEffectiveSamples %j", (maxEffectiveSamples) => {
    expect(() => validateConfig(withRouting({ outcomes: { maxEffectiveSamples } }))).toThrow(
      /routing\.outcomes\.maxEffectiveSamples must be a number >= 5 and <= 1000/,
    );
  });

  it("accepts outcomes.path as null or a non-empty string and rejects the rest", () => {
    expect(validateConfig(withRouting({ outcomes: { path: null } })).routing?.outcomes?.path).toBeNull();
    expect(validateConfig(withRouting({ outcomes: { path: "D:/data/omr" } })).routing?.outcomes?.path).toBe("D:/data/omr");
    for (const path of ["", 5, {}]) {
      expect(() => validateConfig(withRouting({ outcomes: { path } }))).toThrow(
        /routing\.outcomes\.path must be null or a non-empty string/,
      );
    }
  });

  it.each([0.01, 0.6, 0.95])("accepts sessionReuse.maxContextFraction %s", (maxContextFraction) => {
    expect(
      validateConfig(withRouting({ sessionReuse: { maxContextFraction } })).routing?.sessionReuse?.maxContextFraction,
    ).toBe(maxContextFraction);
  });

  it.each([0, -0.1, 0.96, 1, "0.6", null])("rejects sessionReuse.maxContextFraction %j", (maxContextFraction) => {
    expect(() => validateConfig(withRouting({ sessionReuse: { maxContextFraction } }))).toThrow(
      /routing\.sessionReuse\.maxContextFraction must be a number > 0 and <= 0.95/,
    );
  });

  it.each([1, 24, 720])("accepts advisor.noticeIntervalHours %s", (noticeIntervalHours) => {
    expect(
      validateConfig(withRouting({ advisor: { noticeIntervalHours } })).routing?.advisor?.noticeIntervalHours,
    ).toBe(noticeIntervalHours);
  });

  it.each([0, 0.5, 721, "24"])("rejects advisor.noticeIntervalHours %j", (noticeIntervalHours) => {
    expect(() => validateConfig(withRouting({ advisor: { noticeIntervalHours } }))).toThrow(
      /routing\.advisor\.noticeIntervalHours must be a number >= 1 and <= 720/,
    );
  });

  it("validates advisor.enabled as a boolean", () => {
    expect(validateConfig(withRouting({ advisor: { enabled: false } })).routing?.advisor?.enabled).toBe(false);
    expect(() => validateConfig(withRouting({ advisor: { enabled: "no" } }))).toThrow(
      /routing\.advisor\.enabled must be a boolean/,
    );
  });

  it.each(["outcomes", "sessionReuse", "advisor"])("rejects %s that is not an object", (key) => {
    expect(() => validateConfig(withRouting({ [key]: 1 }))).toThrow(new RegExp(`routing\\.${key} must be an object`));
  });
});

describe("validateConfig — tiers.<t>.candidates", () => {
  it("accepts a tier without candidates, and an empty list", () => {
    expect(() => validateConfig(validRaw())).not.toThrow();
    expect(() => validateConfig(withCandidates([]))).not.toThrow();
  });

  it("accepts entries that omit model (inherited), variant and costRatio", () => {
    expect(() =>
      validateConfig(withCandidates([{ variant: "medium", costRatio: 5 }, { variant: "high" }, {}])),
    ).not.toThrow();
  });

  it("accepts the same variant on different models and different variants on one model", () => {
    expect(() =>
      validateConfig(
        withCandidates([
          { variant: "high" },
          { model: "openai/gpt-6-luna", variant: "high" },
          { model: "openai/gpt-6-luna", variant: "low" },
        ]),
      ),
    ).not.toThrow();
  });

  it("rejects a repeated (model, variant), reporting both positions", () => {
    expect(() =>
      validateConfig(withCandidates([{ variant: "high" }, { model: "openai/gpt-6-luna" }, { variant: "high" }])),
    ).toThrow(/'anthropic\.fast\.candidates\[2\]' repeats \(model, variant\) = \(anthropic\/claude-haiku-4-5, high\) of candidates\[0\]/);
  });

  it("detects the repeat through inheritance (omitted model == the tier's own model)", () => {
    expect(() =>
      validateConfig(
        withCandidates([{ model: "anthropic/claude-haiku-4-5", variant: "high" }, { variant: "high" }]),
      ),
    ).toThrow(/candidates\[1\]' repeats/);
  });

  it("treats two variant-less entries of the same model as a repeat of the default variant", () => {
    expect(() => validateConfig(withCandidates([{ costRatio: 1 }, { costRatio: 2 }]))).toThrow(
      /repeats \(model, variant\) = \(anthropic\/claude-haiku-4-5, default\)/,
    );
  });

  it.each([0, -1, "5", null, Number.NaN, Number.POSITIVE_INFINITY])("rejects candidate costRatio %j", (costRatio) => {
    expect(() => validateConfig(withCandidates([{ costRatio }]))).toThrow(
      /'anthropic\.fast\.candidates\[0\]\.costRatio' must be a number > 0/,
    );
  });

  it("accepts a fractional costRatio", () => {
    expect(() => validateConfig(withCandidates([{ costRatio: 0.5 }]))).not.toThrow();
  });

  it.each(["gpt", "/gpt", "openai/", 5, null])("rejects candidate model %j", (model) => {
    expect(() => validateConfig(withCandidates([{ model }]))).toThrow(/candidates\[0\]\.model' must be 'provider\/model'/);
  });

  it.each(["", "a b", "a#b", 5, null])("rejects candidate variant %j", (variant) => {
    expect(() => validateConfig(withCandidates([{ variant }]))).toThrow(/candidates\[0\]\.variant' must be a non-empty string/);
  });

  it.each([
    ["an object", {}],
    ["a string", "high"],
    ["null", null],
  ])("rejects candidates being %s", (_label, candidates) => {
    expect(() => validateConfig(withCandidates(candidates))).toThrow(/'anthropic\.fast\.candidates' must be an array/);
  });

  it.each([null, "high", 3, ["high"]])("rejects a candidate entry that is %j", (entry) => {
    expect(() => validateConfig(withCandidates([entry]))).toThrow(/candidates\[0\]' must be an object/);
  });

  it("rejects prototype keys in an entry", () => {
    expect(() => validateConfig(withCandidates([JSON.parse('{"__proto__": {}}')]))).toThrow(/must not contain the key/);
  });
});

describe("validateConfig — enforcement.escalate.variantSteps", () => {
  const withSteps = (variantSteps: unknown) => validRaw({ enforcement: { escalate: { variantSteps } } });

  it.each(["auto", "none"])("accepts %s and keeps it", (variantSteps) => {
    expect(validateConfig(withSteps(variantSteps)).enforcement?.escalate?.variantSteps).toBe(variantSteps);
  });

  it.each(["manual", "", "AUTO", true, null, 1])("rejects %j", (variantSteps) => {
    expect(() => validateConfig(withSteps(variantSteps))).toThrow(
      /enforcement\.escalate\.variantSteps must be one of auto\|none/,
    );
  });

  it("is optional: absent leaves escalate exactly as written", () => {
    const cfg = validateConfig(validRaw({ enforcement: { escalate: { maxTotalAttempts: 3 } } }));
    expect(cfg.enforcement?.escalate).toEqual({ maxTotalAttempts: 3 });
  });
});
