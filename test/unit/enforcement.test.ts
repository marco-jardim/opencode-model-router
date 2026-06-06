import { describe, it, expect } from "vitest";
import {
  resolveEnforcementMode,
  DEFAULT_ENV_GATE,
} from "../../src/router/enforcement";
import type { RouterConfig } from "../../src/router/config";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cfg(enforcement?: RouterConfig["enforcement"]): RouterConfig {
  return {
    activePreset: "default",
    presets: {},
    rules: [],
    defaultTier: "fast",
    enforcement,
  } as RouterConfig;
}

// ---------------------------------------------------------------------------
// DEFAULT_ENV_GATE
// ---------------------------------------------------------------------------

describe("DEFAULT_ENV_GATE", () => {
  it("is MODEL_ROUTER_ENFORCE", () => {
    expect(DEFAULT_ENV_GATE).toBe("MODEL_ROUTER_ENFORCE");
  });
});

// ---------------------------------------------------------------------------
// resolveEnforcementMode — env gate overrides
// ---------------------------------------------------------------------------

describe("resolveEnforcementMode — env gate overrides", () => {
  it('env="1" returns enforced regardless of config mode "off"', () => {
    const result = resolveEnforcementMode({
      config: cfg({ mode: "off" }),
      env: { MODEL_ROUTER_ENFORCE: "1" },
    });
    expect(result.mode).toBe("enforced");
    expect(result.warning).toBeUndefined();
  });

  it('env="1" returns enforced even when perTier for the tier says advisory', () => {
    const result = resolveEnforcementMode({
      config: cfg({ mode: "off", perTier: { fast: "advisory" } }),
      tier: "fast",
      env: { MODEL_ROUTER_ENFORCE: "1" },
    });
    expect(result.mode).toBe("enforced");
    expect(result.warning).toBeUndefined();
  });

  it('env="0" returns off regardless of config mode "enforced"', () => {
    const result = resolveEnforcementMode({
      config: cfg({ mode: "enforced" }),
      env: { MODEL_ROUTER_ENFORCE: "0" },
    });
    expect(result.mode).toBe("off");
    expect(result.warning).toBeUndefined();
  });

  it('env="0" overrides even when perTier says enforced', () => {
    const result = resolveEnforcementMode({
      config: cfg({ mode: "enforced", perTier: { heavy: "enforced" } }),
      tier: "heavy",
      env: { MODEL_ROUTER_ENFORCE: "0" },
    });
    expect(result.mode).toBe("off");
  });
});

// ---------------------------------------------------------------------------
// resolveEnforcementMode — unrecognised env value
// ---------------------------------------------------------------------------

describe("resolveEnforcementMode — unrecognised env value", () => {
  it('env="x" falls through to config and attaches a warning', () => {
    const result = resolveEnforcementMode({
      config: cfg({ mode: "advisory" }),
      env: { MODEL_ROUTER_ENFORCE: "x" },
    });
    expect(result.mode).toBe("advisory");
    expect(result.warning).toBeDefined();
    expect(result.warning).toContain("MODEL_ROUTER_ENFORCE");
    expect(result.warning).toContain('"x"');
    expect(result.warning).toContain('is not "1" or "0"');
  });

  it("warning contains the actual gateName (not the literal DEFAULT_ENV_GATE) for custom gates", () => {
    const result = resolveEnforcementMode({
      config: cfg({ mode: "off", envGate: "MY_GATE" }),
      env: { MY_GATE: "yes" },
    });
    expect(result.warning).toContain("MY_GATE");
    expect(result.warning).not.toContain("MODEL_ROUTER_ENFORCE");
    expect(result.mode).toBe("off");
  });

  it('env="" (empty string) does NOT produce a warning and falls through to config', () => {
    const result = resolveEnforcementMode({
      config: cfg({ mode: "advisory" }),
      env: { MODEL_ROUTER_ENFORCE: "" },
    });
    expect(result.mode).toBe("advisory");
    expect(result.warning).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveEnforcementMode — config resolution (env unset/missing)
// ---------------------------------------------------------------------------

describe("resolveEnforcementMode — config resolution", () => {
  it("config undefined returns mode advisory", () => {
    const result = resolveEnforcementMode({ config: undefined });
    expect(result.mode).toBe("advisory");
  });

  it("config present but enforcement undefined returns mode advisory", () => {
    const result = resolveEnforcementMode({
      config: cfg(undefined),
      env: {},
    });
    expect(result.mode).toBe("advisory");
  });

  it("config enforcement with no mode field defaults to advisory", () => {
    const result = resolveEnforcementMode({
      config: cfg({}),
      env: {},
    });
    expect(result.mode).toBe("advisory");
  });

  it("config.enforcement.mode is used as base when env is unset", () => {
    const result = resolveEnforcementMode({
      config: cfg({ mode: "advisory" }),
      env: {},
    });
    expect(result.mode).toBe("advisory");
  });

  it("no env argument at all resolves from config", () => {
    const result = resolveEnforcementMode({
      config: cfg({ mode: "enforced" }),
    });
    expect(result.mode).toBe("enforced");
  });

  it("perTier overrides base when tier is provided and present in perTier", () => {
    const result = resolveEnforcementMode({
      config: cfg({ mode: "off", perTier: { heavy: "enforced" } }),
      tier: "heavy",
      env: {},
    });
    expect(result.mode).toBe("enforced");
  });

  it("perTier advisory overrides base off for matching tier", () => {
    const result = resolveEnforcementMode({
      config: cfg({ mode: "off", perTier: { medium: "advisory" } }),
      tier: "medium",
      env: {},
    });
    expect(result.mode).toBe("advisory");
  });

  it("tier provided but absent from perTier falls back to base mode", () => {
    const result = resolveEnforcementMode({
      config: cfg({ mode: "advisory", perTier: { heavy: "enforced" } }),
      tier: "fast",
      env: {},
    });
    expect(result.mode).toBe("advisory");
  });

  it("no tier provided uses base mode even when perTier is defined", () => {
    const result = resolveEnforcementMode({
      config: cfg({ mode: "advisory", perTier: { fast: "enforced" } }),
      env: {},
    });
    expect(result.mode).toBe("advisory");
  });

  it("custom envGate is respected — reads from that key, not MODEL_ROUTER_ENFORCE", () => {
    // MODEL_ROUTER_ENFORCE="0" would give off, but MY_CUSTOM_GATE="1" should give enforced
    const result = resolveEnforcementMode({
      config: cfg({ mode: "off", envGate: "MY_CUSTOM_GATE" }),
      env: { MY_CUSTOM_GATE: "1", MODEL_ROUTER_ENFORCE: "0" },
    });
    expect(result.mode).toBe("enforced");
  });

  it("custom envGate env=0 overrides config enforced", () => {
    const result = resolveEnforcementMode({
      config: cfg({ mode: "enforced", envGate: "MY_GATE" }),
      env: { MY_GATE: "0" },
    });
    expect(result.mode).toBe("off");
  });
});
