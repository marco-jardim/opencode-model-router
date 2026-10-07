import { afterEach, describe, it, expect, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  invalidateConfigCache,
  loadConfig,
  localOverridePath,
  overridePath,
  resolveDepthLimit,
  resolveEffortBump,
  validateConfig,
  writeState,
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

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function withOverrideFile(run: (path: string) => void): void {
  const savedCwd = process.cwd();
  const root = mkdtempSync(join(tmpdir(), "depth-effort-"));
  tempRoots.push(root);
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(project, ".git"), { recursive: true });
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  try {
    process.chdir(project);
    invalidateConfigCache();
    const path = overridePath();
    mkdirSync(dirname(path), { recursive: true });
    run(path);
  } finally {
    process.chdir(savedCwd);
    vi.unstubAllEnvs();
    invalidateConfigCache();
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

describe("depth and effort bump config — defaults and validation", () => {
  it.each([
    {},
    { enforcement: {} },
    { enforcement: { mode: "off" } },
    { enforcement: { escalate: {} } },
    { enforcement: { escalate: { maxTotalAttempts: 2 } } },
    { enforcement: { maxDelegationDepth: undefined, escalate: { effortBump: undefined, effortBumpMax: undefined } } },
  ])("resolves defaults for absent/empty/partial blocks: %j", (extra) => {
    const cfg = validateConfig(validRaw(extra));
    expect(resolveDepthLimit(cfg)).toBe(1);
    expect(resolveEffortBump(cfg)).toEqual({ enabled: true, max: "xhigh" });
  });

  it.each([null, 1, 2, 32])("accepts maxDelegationDepth %s", (maxDelegationDepth) => {
    const cfg = validateConfig(validRaw({ enforcement: { maxDelegationDepth } }));
    expect(resolveDepthLimit(cfg)).toBe(maxDelegationDepth);
  });

  it.each([
    ["zero", 0, "0"], ["negative", -1, "-1"], ["negative zero", -0, "-0"],
    ["fraction", 1.5, "1.5"], ["NaN", NaN, "NaN"],
    ["Infinity", Infinity, "Infinity"], ["overflow", 1e400, "Infinity"],
    ["string", "1", '"1"'], ["boolean", true, "true"],
    ["array", [], "array []"], ["object", {}, "object {}"],
    ["above limit", 33, "33"], ["old unbounded limit", 100, "100"],
    ["huge integer", 1e300, "1e+300"], ["unsafe integer", 2 ** 53 + 2, "9007199254740994"],
  ])("rejects maxDelegationDepth %s with the exact received-value message", (_label, value, received) => {
    expect(() => validateConfig(validRaw({ enforcement: { maxDelegationDepth: value } })))
      .toThrowError(new Error(`tiers.json: enforcement.maxDelegationDepth must be null or an integer from 1 to 32 (got ${received})`));
  });

  it.each([true, false])("accepts effortBump %s", (effortBump) => {
    const cfg = validateConfig(validRaw({ enforcement: { escalate: { effortBump } } }));
    expect(resolveEffortBump(cfg)).toEqual({ enabled: effortBump, max: "xhigh" });
  });

  it.each(["true", 0, null])("rejects effortBump %s with the exact received-value message", (effortBump) => {
    expect(() => validateConfig(validRaw({ enforcement: { escalate: { effortBump } } })))
      .toThrowError(new Error(`tiers.json: enforcement.escalate.effortBump must be a boolean (got ${JSON.stringify(effortBump)})`));
  });

  it.each(["low", "medium", "high", "xhigh", "max"])("accepts effortBumpMax %s", (effortBumpMax) => {
    const cfg = validateConfig(validRaw({ enforcement: { escalate: { effortBumpMax } } }));
    expect(resolveEffortBump(cfg)).toEqual({ enabled: true, max: effortBumpMax });
  });

  it.each(["High", "ultra", "", null, 3])("rejects effortBumpMax %s with the exact received-value message", (effortBumpMax) => {
    expect(() => validateConfig(validRaw({ enforcement: { escalate: { effortBumpMax } } })))
      .toThrowError(new Error(`tiers.json: enforcement.escalate.effortBumpMax must be one of low|medium|high|xhigh|max (got ${JSON.stringify(effortBumpMax)})`));
  });
});

describe("depth and effort bump config — regression cases", () => {
  it.each([undefined, { maxDelegationDepth: 2 }])("preserves inherited root properties with enforcement %s", (enforcement) => {
    const raw = validRaw({ enforcement });
    const prototype = { rules: raw.rules, defaultTier: raw.defaultTier };
    delete raw.rules;
    delete raw.defaultTier;
    Object.setPrototypeOf(raw, prototype);
    const cfg = validateConfig(raw);
    expect(Object.getPrototypeOf(cfg)).toBe(prototype);
    expect(cfg.rules).toBe(prototype.rules);
    expect(cfg.defaultTier).toBe(prototype.defaultTier);
    expect(Object.hasOwn(cfg, "rules")).toBe(false);
  });

  it("keeps escalate arrays as arrays and validates their existing fields", () => {
    const escalate = Object.assign([], { effortBump: false });
    const cfg = validateConfig(validRaw({ enforcement: { escalate } }));
    expect(Array.isArray(cfg.enforcement?.escalate)).toBe(true);
    expect(cfg.enforcement?.escalate).toEqual(escalate);
    const empty = validateConfig(validRaw({ enforcement: { escalate: [] } }));
    expect(empty.enforcement?.escalate).toEqual([]);
    expect(Array.isArray(empty.enforcement?.escalate)).toBe(true);
    expect(() => validateConfig(validRaw({ enforcement: { escalate: Object.assign([], { maxTotalAttempts: 0 }) } })))
      .toThrowError("enforcement.escalate.maxTotalAttempts must be an integer >= 1");
  });

  it.each([false, true])("preserves frozenness for copied objects and arrays (array=%s)", (array) => {
    const escalate = array ? Object.assign([], { effortBump: false }) : { effortBump: false };
    const raw = deepFreeze(validRaw({ enforcement: { maxDelegationDepth: 2, escalate } }));
    const cfg = validateConfig(raw);
    expect(cfg).not.toBe(raw);
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(Object.isFrozen(cfg.enforcement)).toBe(true);
    expect(Object.isFrozen(cfg.enforcement?.escalate)).toBe(true);
    expect(Object.getOwnPropertyDescriptor(cfg, "enforcement")?.writable).toBe(false);
    expect(Array.isArray(cfg.enforcement?.escalate)).toBe(array);
  });

  it.each([undefined, { maxDelegationDepth: 2 }])("reads the enforcement parent once, including %s", (first) => {
    let reads = 0;
    const raw = validRaw();
    Object.defineProperty(raw, "enforcement", {
      enumerable: true,
      get: () => ++reads === 1 ? first : { maxDelegationDepth: -5 },
    });
    const cfg = validateConfig(raw);
    expect(resolveDepthLimit(cfg)).toBe(first?.maxDelegationDepth ?? 1);
    expect(reads).toBe(1);
    expect(Object.getOwnPropertyDescriptor(cfg, "enforcement")?.get).toBeUndefined();
  });

  it.each([undefined, { effortBump: false, effortBumpMax: "high" }])("reads the escalate parent once, including %s", (first) => {
    let reads = 0;
    const enforcement = {
      get escalate() { return ++reads === 1 ? first : { effortBump: "yes", effortBumpMax: "ultra" }; },
    };
    const cfg = validateConfig(validRaw({ enforcement }));
    expect(resolveEffortBump(cfg)).toEqual({ enabled: first?.effortBump ?? true, max: first?.effortBumpMax ?? "xhigh" });
    expect(reads).toBe(1);
    expect(Object.getOwnPropertyDescriptor(cfg.enforcement, "escalate")?.get).toBeUndefined();
  });

  it.each(["maxDelegationDepth", "effortBump", "effortBumpMax"])("snapshots own %s even when a Proxy hides it from in", (key) => {
    let reads = 0;
    const first = key === "maxDelegationDepth" ? 2 : key === "effortBump" ? false : "high";
    const target = Object.defineProperty({}, key, {
      configurable: true, enumerable: true,
      get: () => ++reads === 1 ? first : -7,
    });
    const proxy = new Proxy(target, { has: () => false });
    const enforcement = key === "maxDelegationDepth" ? proxy : { escalate: proxy };
    const cfg = validateConfig(validRaw({ enforcement }));
    expect(resolveDepthLimit(cfg)).toBe(key === "maxDelegationDepth" ? 2 : 1);
    expect(resolveEffortBump(cfg)).toEqual({ enabled: key !== "effortBump", max: key === "effortBumpMax" ? "high" : "xhigh" });
    expect(reads).toBe(1);
  });

  it.each(["maxDelegationDepth", "effortBump", "effortBumpMax"])("snapshots get-only Proxy %s without an own or inherited key", (key) => {
    let reads = 0;
    const first = key === "maxDelegationDepth" ? 2 : key === "effortBump" ? false : "high";
    const proxy = new Proxy({}, {
      get: (target, property, receiver) => property === key
        ? (++reads === 1 ? first : -7)
        : Reflect.get(target, property, receiver),
    });
    expect(Object.hasOwn(proxy, key)).toBe(false);
    expect(key in proxy).toBe(false);
    const enforcement = key === "maxDelegationDepth" ? proxy : { escalate: proxy };
    const cfg = validateConfig(validRaw({ enforcement }));
    expect(resolveDepthLimit(cfg)).toBe(key === "maxDelegationDepth" ? 2 : 1);
    expect(resolveEffortBump(cfg)).toEqual({ enabled: key !== "effortBump", max: key === "effortBumpMax" ? "high" : "xhigh" });
    expect(reads).toBe(1);
  });

  it("snapshots a get-only root Proxy enforcement value", () => {
    let reads = 0;
    const enforcement = { maxDelegationDepth: 2, escalate: { effortBump: false, effortBumpMax: "high" } };
    const raw = new Proxy(validRaw(), {
      get: (target, property, receiver) => property === "enforcement"
        ? (++reads === 1 ? enforcement : { maxDelegationDepth: -7 })
        : Reflect.get(target, property, receiver),
    });
    expect(Object.hasOwn(raw, "enforcement")).toBe(false);
    expect("enforcement" in raw).toBe(false);
    const cfg = validateConfig(raw);
    expect(resolveDepthLimit(cfg)).toBe(2);
    expect(resolveEffortBump(cfg)).toEqual({ enabled: false, max: "high" });
    expect(cfg.enforcement).toEqual(enforcement);
    expect(reads).toBe(1);
  });

  it.each([
    [{ toString: 1 }, 'object {"toString":1}'],
    [Object.create(null), "object {}"],
    [Symbol("invalid"), "Symbol(invalid)"],
    [2n, "2n"],
    [new Number(2), "object 2"],
    [-0, "-0"],
    [[], "array []"],
    ["", '""'],
    ["true", '"true"'],
    ["x".repeat(5000), `"${"x".repeat(78)}…`],
    ["a" + "😀".repeat(100), `"a${"😀".repeat(38)}…`],
  ])("safely describes invalid values for all three keys: %s", (value, description) => {
    for (const key of ["maxDelegationDepth", "effortBump", "effortBumpMax"]) {
      const enforcement = key === "maxDelegationDepth" ? { [key]: value } : { escalate: { [key]: value } };
      expect(() => validateConfig(validRaw({ enforcement })))
        .toThrowError(`(got ${description})`);
      expect(String(description).length).toBeLessThanOrEqual(80);
    }
  });

  it("falls back to a type tag for circular objects and throwing serializers", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const throwing = { toJSON() { throw new Error("do not leak this"); } };
    for (const value of [circular, throwing]) {
      for (const key of ["maxDelegationDepth", "effortBump", "effortBumpMax"]) {
        const enforcement = key === "maxDelegationDepth" ? { [key]: value } : { escalate: { [key]: value } };
        expect(() => validateConfig(validRaw({ enforcement }))).toThrowError("(got <object>)");
      }
    }
  });

  it.each(["__proto__", "constructor", "prototype"])("rejects own %s keys in enforcement containers", (key) => {
    for (const path of ["enforcement", "enforcement.escalate"]) {
      const dangerous: unknown = JSON.parse(`{"${key}":{"maxDelegationDepth":null,"effortBump":false}}`);
      const enforcement = path === "enforcement" ? dangerous : { escalate: dangerous };
      expect(() => validateConfig(validRaw({ enforcement })))
        .toThrowError(`tiers.json: ${path} must not contain the key "${key}"`);
    }
  });

  it("reads maxDelegationDepth once and returns the validated snapshot", () => {
    let reads = 0;
    const enforcement = {
      get maxDelegationDepth() {
        return ++reads === 1 ? 2 : -1;
      },
    };

    const cfg = validateConfig(validRaw({ enforcement }));
    expect(reads).toBe(1);
    expect(cfg.enforcement?.maxDelegationDepth).toBe(2);
    expect(reads).toBe(1);
    expect(resolveDepthLimit(cfg)).toBe(2);
    expect(cfg.enforcement).not.toBe(enforcement);
    expect(Object.getOwnPropertyDescriptor(enforcement, "maxDelegationDepth")?.get).toBeTypeOf("function");
    expect(Object.getOwnPropertyDescriptor(cfg.enforcement, "maxDelegationDepth")).toEqual({
      value: 2, writable: true, enumerable: true, configurable: true,
    });
  });

  it.each([
    ["effortBump", false, "true"],
    ["effortBumpMax", "high", "ultra"],
    ["effortBump", undefined, false],
    ["effortBumpMax", undefined, "low"],
  ])("snapshots the %s accessor exactly once (first value %s)", (key, first, later) => {
    let reads = 0;
    const escalate = Object.defineProperty({}, key, {
      get: () => ++reads === 1 ? first : later,
      enumerable: true,
    });
    const enforcement = { escalate };
    const raw = validRaw({ enforcement });
    const cfg = validateConfig(raw);
    expect(reads).toBe(1);
    expect(Object.getOwnPropertyDescriptor(cfg.enforcement?.escalate, key)).toEqual({
      value: first, writable: true, enumerable: true, configurable: true,
    });
    expect(resolveEffortBump(cfg)).toEqual({
      enabled: key === "effortBump" ? first ?? true : true,
      max: key === "effortBumpMax" ? first ?? "xhigh" : "xhigh",
    });
    expect(reads).toBe(1);
    expect(raw.enforcement).toBe(enforcement);
    expect(enforcement.escalate).toBe(escalate);
    expect(cfg.enforcement?.escalate).not.toBe(escalate);
    expect(Object.getOwnPropertyDescriptor(escalate, key)?.get).toBeTypeOf("function");
  });

  it("retains an undefined depth snapshot instead of reading its later value", () => {
    let reads = 0;
    const enforcement = { get maxDelegationDepth() { return ++reads === 1 ? undefined : 100; } };
    const cfg = validateConfig(validRaw({ enforcement }));
    expect(resolveDepthLimit(cfg)).toBe(1);
    expect(cfg.enforcement?.maxDelegationDepth).toBeUndefined();
    expect(reads).toBe(1);
  });

  it("does not materialize absent keys or change unrelated property descriptors/references", () => {
    let reads = 0;
    const guard = { budget: 2 };
    const escalate = { ladder: ["fast"], get extra() { reads++; return "unchanged"; } };
    const raw = validRaw({ enforcement: { guard, escalate } });
    Object.defineProperty(raw, "extra", { get() { reads++; return "unchanged"; }, enumerable: true });
    const cfg = validateConfig(raw);
    expect(reads).toBe(0);
    expect(cfg.enforcement?.guard).toBe(guard);
    expect(cfg.enforcement?.escalate?.ladder).toBe(escalate.ladder);
    expect(Object.getOwnPropertyDescriptor(cfg.enforcement?.escalate, "extra"))
      .toEqual(Object.getOwnPropertyDescriptor(escalate, "extra"));
    expect(Object.getOwnPropertyDescriptor(cfg, "extra"))
      .toEqual(Object.getOwnPropertyDescriptor(raw, "extra"));
    expect(Object.hasOwn(cfg.enforcement ?? {}, "maxDelegationDepth")).toBe(false);
    expect(Object.hasOwn(cfg.enforcement?.escalate ?? {}, "effortBump")).toBe(false);
    expect(Object.hasOwn(cfg.enforcement?.escalate ?? {}, "effortBumpMax")).toBe(false);
  });

  it.each([
    [{ maxDelegationDepth: 2, escalate: { effortBump: false, effortBumpMax: "ultra" } }, "enforcement.escalate.effortBumpMax", '"ultra"'],
    [{ maxDelegationDepth: 0 }, "enforcement.maxDelegationDepth", "0"],
    [{ escalate: { effortBump: "true" } }, "enforcement.escalate.effortBump", '"true"'],
  ])("drops a bad override without preventing startup and names its offending value: %j", (enforcement, key, received) => {
    // Match the existing override integration seam: isolate HOME and cwd rather
    // than mocking validation or merge, and leave the bundled tiers.json intact.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      withOverrideFile((path) => {
        const bundled = loadConfig();
        writeFileSync(path, JSON.stringify({ enforcement }), "utf-8");
        invalidateConfigCache();
        const cfg = loadConfig();
        expect(cfg).toEqual(bundled);
        expect(resolveDepthLimit(cfg)).toBe(1);
        expect(resolveEffortBump(cfg)).toEqual({ enabled: true, max: "xhigh" });
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("ignoring"));
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(key));
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`(got ${received})`));
      });
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("depth and effort bump config — overrides and purity", () => {
  it("merges global and project keys in order without discarding siblings", () => {
    withOverrideFile((path) => {
      writeFileSync(path, JSON.stringify({ enforcement: { maxDelegationDepth: 2, escalate: { effortBump: false } } }));
      const projectPath = localOverridePath();
      mkdirSync(dirname(projectPath), { recursive: true });
      writeFileSync(projectPath, JSON.stringify({ enforcement: { maxDelegationDepth: 3, escalate: { effortBumpMax: "high" } } }));
      const cfg = loadConfig();
      expect(resolveDepthLimit(cfg)).toBe(3);
      expect(resolveEffortBump(cfg)).toEqual({ enabled: false, max: "high" });
    });
  });

  it("keeps a good global layer when the project layer is invalid", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      withOverrideFile((path) => {
        writeFileSync(path, JSON.stringify({ enforcement: { maxDelegationDepth: 2, escalate: { effortBump: false, effortBumpMax: "low" } } }));
        const projectPath = localOverridePath();
        mkdirSync(dirname(projectPath), { recursive: true });
        writeFileSync(projectPath, JSON.stringify({ enforcement: { maxDelegationDepth: 33, escalate: { effortBump: true } } }));
        const cfg = loadConfig();
        expect(resolveDepthLimit(cfg)).toBe(2);
        expect(resolveEffortBump(cfg)).toEqual({ enabled: false, max: "low" });
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(`ignoring ${projectPath}`));
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("keeps depth and effort snapshots through the state-file enforcementMode spread", () => {
    withOverrideFile((path) => {
      writeFileSync(path, JSON.stringify({ enforcement: { maxDelegationDepth: 2, escalate: { effortBump: false, effortBumpMax: "high" } } }));
      writeState({ enforcementMode: "enforced" });
      const cfg = loadConfig();
      expect(cfg.enforcement?.mode).toBe("enforced");
      expect(resolveDepthLimit(cfg)).toBe(2);
      expect(resolveEffortBump(cfg)).toEqual({ enabled: false, max: "high" });
      expect(Object.getOwnPropertyDescriptor(cfg.enforcement, "maxDelegationDepth")?.value).toBe(2);
      expect(Object.getOwnPropertyDescriptor(cfg.enforcement?.escalate, "effortBump")?.value).toBe(false);
      expect(Object.getOwnPropertyDescriptor(cfg.enforcement?.escalate, "effortBumpMax")?.value).toBe("high");
    });
  });

  it.each([
    [{ escalate: { effortBump: false } }, 1, { enabled: false, max: "xhigh" }],
    [{ maxDelegationDepth: 2 }, 2, { enabled: true, max: "xhigh" }],
    [{ escalate: { effortBumpMax: "high" } }, 1, { enabled: true, max: "high" }],
  ])("merges a single-key override without losing other defaults: %j", (enforcement, depth, bump) => {
    withOverrideFile((path) => {
      writeFileSync(path, JSON.stringify({ enforcement }), "utf-8");
      const cfg = loadConfig();
      expect(resolveDepthLimit(cfg)).toBe(depth);
      expect(resolveEffortBump(cfg)).toEqual(bump);
    });
  });

  it.each(["__proto__", "constructor"])("does not pollute prototypes through an override %s key", (key) => {
    const before = Object.getOwnPropertyDescriptors(Object.prototype);
    withOverrideFile((path) => {
      writeFileSync(path, `{"${key}":{"depthEffortPolluted":true},"enforcement":{"${key}":{"depthEffortPolluted":true},"maxDelegationDepth":2,"escalate":{"${key}":{"prototype":{"depthEffortPolluted":true}},"effortBump":false}}}`, "utf-8");
      const cfg = loadConfig();
      expect(resolveDepthLimit(cfg)).toBe(2);
      expect(resolveEffortBump(cfg)).toEqual({ enabled: false, max: "xhigh" });
      for (const object of [cfg, cfg.enforcement, cfg.enforcement?.escalate]) {
        expect(Object.getPrototypeOf(object)).toBe(Object.prototype);
        expect(Object.hasOwn(object ?? {}, key)).toBe(false);
      }
    });
    expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(before);
  });

  it.each([
    {},
    { enforcement: {} },
    { enforcement: { maxDelegationDepth: null, escalate: { effortBump: false, effortBumpMax: "low" } } },
    { enforcement: { maxDelegationDepth: 32, escalate: { effortBump: true, effortBumpMax: "max" } } },
  ])("resolvers are deterministic and do not mutate deeply frozen config: %j", (extra) => {
    const cfg: RouterConfig = deepFreeze(validateConfig(deepFreeze(validRaw(extra))));
    const before = structuredClone(cfg);
    expect(resolveDepthLimit(cfg)).toEqual(resolveDepthLimit(cfg));
    expect(resolveEffortBump(cfg)).toEqual(resolveEffortBump(cfg));
    expect(resolveEffortBump(cfg)).not.toBe(resolveEffortBump(cfg));
    expect(cfg).toEqual(before);
  });
});
