import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import ModelRouterPlugin from "../../src/index";
import {
  DEFAULT_V2_ROLES,
  ROUTING_DEFAULTS,
  ROUTING_ENGINE_IGNORED_ON_V1,
  ROUTING_RESERVED_AGENTS,
  ROUTING_TASK_CLASSES,
  collectRoutingNotices,
  deepMerge,
  findUnknownRoutingKeys,
  getConfigNotices,
  candidatesProblem,
  getConfigReloadError,
  hasExplicitCandidates,
  warnConfigNotices,
  writeState,
  invalidateConfigCache,
  loadConfig,
  overridePath,
  resetRoutingWarnings,
  resolveCandidates,
  resolveClassifierForPreset,
  resolveRouting,
  resolveVariantSteps,
  statePath,
  validateConfig,
  type RouterConfig,
} from "../../src/router/config";
import {
  buildInfo,
  formatRouterLine,
  loadBuildInfo,
  readBuildInfo,
  readGitSha,
  readPackageVersion,
} from "../../src/router/build-info";
import { parseJsonc } from "../../src/router/jsonc";
import { assertHomeIsGuarded, guardedHomedir, sameDir, REAL_HOME } from "../setup/home-guard";
import { readFileSync } from "node:fs";

const ROOT = resolve(__dirname, "..", "..");
/** An absolute path on any platform (routing.outcomes.path must be absolute). */
const ABS_PATH = resolve(tmpdir(), "omr-outcomes");

// ---------------------------------------------------------------------------
// Isolation from the real home directory (QA-1.1-1).
//
// config.ts builds the global override and state paths from `os.homedir()`.
// Redirecting `process.env.HOME` / `USERPROFILE` is NOT enough: under
// `--pool=threads` (worker threads) an env change does not reach `homedir()`, and
// a test that writes "the global override" then writes the user's real file.
// The global setup file test/setup/home-guard.ts mocks `node:os` homedir for every
// test file (it follows the env redirect below in any pool). This file redirects
// the env as well and a guard fails every test BEFORE it can write if either path
// is outside the temporary home, so a missing or broken setup file cannot go unnoticed.
// ---------------------------------------------------------------------------

// REAL_HOME was captured by setup before it exported the private home to native children.
const ORIGINAL_ENV = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

let tmpHome = "";
let restoreHomeEnv: () => void = () => {};

/** Throw unless `p` is a path strictly inside the temporary home. */
function assertInsideTmpHome(p: string): void {
  const rel = tmpHome === "" ? "" : relative(tmpHome, p);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `config.routing.test: refusing to touch ${p}: it is not inside the temporary home "${tmpHome}" (QA-1.1-1)`,
    );
  }
}

beforeEach(() => {
  const savedHome = process.env.HOME;
  const savedUserProfile = process.env.USERPROFILE;
  restoreHomeEnv = () => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
  };
  tmpHome = mkdtempSync(join(tmpdir(), "oc-mr-routing-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  // Before any test body can write: where the module under test would write.
  if (homedir() !== tmpHome) {
    throw new Error(`config.routing.test: os.homedir() is "${homedir()}", not the temporary home "${tmpHome}" (QA-1.1-1)`);
  }
  assertInsideTmpHome(overridePath());
  assertInsideTmpHome(statePath());
  invalidateConfigCache();
});

afterEach(() => {
  restoreHomeEnv();
  if (tmpHome !== "") rmSync(tmpHome, { recursive: true, force: true });
  tmpHome = "";
  invalidateConfigCache();
});

/** A raw config with three tiers; `extra` overrides or adds top-level keys. */
function rawConfig(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    activePreset: "anthropic",
    presets: {
      anthropic: {
        fast: { model: "anthropic/claude-sonnet-5-5", variant: "low", costRatio: 1 },
        medium: {
          model: "anthropic/claude-sonnet-5-5",
          variant: "medium",
          costRatio: 5,
          candidates: [
            { variant: "medium", costRatio: 5 },
            { variant: "high", costRatio: 8 },
          ],
        },
        heavy: { model: "anthropic/claude-opus-5-5", variant: "xhigh", costRatio: 20 },
        plain: { model: "openai/gpt-6-luna" },
      },
      other: {
        fast: { model: "openai/gpt-6-luna-fast", variant: "medium", costRatio: 2 },
      },
    },
    rules: ["r1"],
    defaultTier: "fast",
    ...extra,
  };
}

function cfgOf(extra: Record<string, unknown> = {}): RouterConfig {
  return validateConfig(rawConfig(extra));
}

/** Documented defaults on OpenCode v2 (D12 roles). */
const V2_DEFAULTS = {
  engine: "static",
  profile: "balanced",
  margin: 0.2,
  minClassConfidence: 0.7,
  detection: { deterministic: 0.95, grader: 0.7, none: 0.3 },
  classifier: {
    backend: "rules",
    model: null,
    baseUrl: null,
    apiKeyEnv: null,
    timeoutMs: 1500,
    samples: 1,
    maxStateChars: 2000,
    presets: {},
  },
  roles: { search: ["explore"], implement: ["general"], debug: ["general"], review: ["general"] },
  outcomes: { path: null, halfLifeDays: 14, maxEffectiveSamples: 50 },
  sessionReuse: { maxContextFraction: 0.6 },
  advisor: { enabled: true, noticeIntervalHours: 24, notify: true },
  applied: { host: "v2", requestedEngine: "static", engineCoerced: false, rolesSource: "default" },
};

/** Documented defaults on OpenCode v1: no roles (D1). */
const V1_DEFAULTS = {
  ...V2_DEFAULTS,
  roles: {},
  applied: { host: "v1", requestedEngine: "static", engineCoerced: false, rolesSource: "none" },
};

/** Every leaf value reachable from `value`, depth-first. */
function leaves(value: unknown, path = "$"): Array<[string, unknown]> {
  if (typeof value !== "object" || value === null) return [[path, value]];
  return Object.entries(value).flatMap(([k, v]) => leaves(v, `${path}.${k}`));
}

/** Every object (and array) reachable from `value`, including `value`. */
function containers(value: unknown, path = "$"): Array<[string, object]> {
  if (typeof value !== "object" || value === null) return [];
  return [
    [path, value],
    ...Object.entries(value).flatMap(([k, v]) => containers(v, `${path}.${k}`)),
  ];
}

describe("resolveRouting — defaults (documented, per host)", () => {
  beforeEach(() => resetRoutingWarnings());

  it("equals the documented defaults on v2 for an empty config, with D12 roles", () => {
    expect(resolveRouting(cfgOf(), "v2")).toEqual(V2_DEFAULTS);
  });

  it("equals the documented defaults on v1 for an empty config: roles {} and engine static", () => {
    expect(resolveRouting(cfgOf(), "v1")).toEqual(V1_DEFAULTS);
  });

  it("treats an undefined config like an empty one", () => {
    expect(resolveRouting(undefined, "v2")).toEqual(V2_DEFAULTS);
    expect(resolveRouting(undefined, "v1")).toEqual(V1_DEFAULTS);
  });

  it("treats an empty routing block like an absent one", () => {
    expect(resolveRouting(cfgOf({ routing: {} }), "v2")).toEqual(V2_DEFAULTS);
  });

  it("exposes the same defaults as ROUTING_DEFAULTS and DEFAULT_V2_ROLES", () => {
    const { classifier, roles, applied: _applied, ...rest } = V2_DEFAULTS;
    const { presets: _presets, ...classifierDefaults } = classifier;
    expect(ROUTING_DEFAULTS).toEqual({ ...rest, classifier: classifierDefaults });
    expect(DEFAULT_V2_ROLES).toEqual(roles);
  });

  it("never returns an undefined field, at any depth, on either host", () => {
    for (const host of ["v1", "v2"] as const) {
      for (const [path, value] of leaves(resolveRouting(cfgOf(), host))) {
        expect(value, `${host} ${path}`).not.toBeUndefined();
      }
    }
  });

  it("returns a deeply frozen object", () => {
    const resolved = resolveRouting(
      cfgOf({
        routing: {
          classifier: { backend: "host", model: "a/b", presets: { other: { model: "c/d" } } },
          roles: { search: ["explore"] },
        },
      }),
      "v2",
    );
    for (const [path, object] of containers(resolved)) {
      expect(Object.isFrozen(object), path).toBe(true);
    }
    expect(() => {
      (resolved as { margin: number }).margin = 0.5;
    }).toThrow(TypeError);
    expect(() => {
      (resolved.roles.search as string[]).push("x");
    }).toThrow(TypeError);
  });

  it("does not freeze or alias the config it was given", () => {
    const cfg = cfgOf({ routing: { roles: { search: ["explore", "explore", "scout"] } } });
    const resolved = resolveRouting(cfg, "v2");
    expect(Object.isFrozen(cfg.routing)).toBe(false);
    expect(Object.isFrozen(cfg.routing?.roles?.search)).toBe(false);
    expect(resolved.roles.search).not.toBe(cfg.routing?.roles?.search);
    expect(cfg.routing?.roles?.search).toEqual(["explore", "explore", "scout"]);
    expect(resolved.roles.search).toEqual(["explore", "scout"]);
  });

  it("returns a fresh object per call (a later reload is never shadowed)", () => {
    const cfg = cfgOf();
    expect(resolveRouting(cfg, "v2")).not.toBe(resolveRouting(cfg, "v2"));
  });
});

describe("resolveRouting — configured values", () => {
  beforeEach(() => resetRoutingWarnings());

  it("applies every configured value on v2 and defaults the rest of a partial block", () => {
    const resolved = resolveRouting(
      cfgOf({
        routing: {
          engine: "enforce",
          profile: "safe",
          margin: 0.9,
          minClassConfidence: 0.5,
          detection: { grader: 0.5 },
          classifier: {
            backend: "openai-compatible",
            model: "local/qwen#low",
            baseUrl: "http://localhost:11434/v1",
            apiKeyEnv: "OMR_KEY",
            timeoutMs: 30000,
            samples: 3,
            maxStateChars: 200,
          },
          outcomes: { path: ABS_PATH, halfLifeDays: 30 },
          sessionReuse: { maxContextFraction: 0.95 },
          advisor: { enabled: false },
        },
      }),
      "v2",
    );
    expect(resolved).toEqual({
      engine: "enforce",
      profile: "safe",
      margin: 0.9,
      minClassConfidence: 0.5,
      detection: { deterministic: 0.95, grader: 0.5, none: 0.3 },
      classifier: {
        backend: "openai-compatible",
        model: "local/qwen#low",
        baseUrl: "http://localhost:11434/v1",
        apiKeyEnv: "OMR_KEY",
        timeoutMs: 30000,
        samples: 3,
        maxStateChars: 200,
        presets: {},
      },
      roles: V2_DEFAULTS.roles,
      outcomes: { path: ABS_PATH, halfLifeDays: 30, maxEffectiveSamples: 50 },
      sessionReuse: { maxContextFraction: 0.95 },
      advisor: { enabled: false, noticeIntervalHours: 24, notify: true },
      applied: { host: "v2", requestedEngine: "enforce", engineCoerced: false, rolesSource: "default" },
    });
  });

  it("expands a leading ~ in outcomes.path to the home directory (QA-1.1-15)", () => {
    const pathOf = (path: string) => resolveRouting(cfgOf({ routing: { outcomes: { path } } }), "v2").outcomes.path;
    expect(pathOf("~")).toBe(tmpHome);
    expect(pathOf("~/omr-data")).toBe(join(tmpHome, "omr-data"));
    expect(pathOf("~\\omr-data")).toBe(join(tmpHome, "omr-data"));
    expect(pathOf(ABS_PATH)).toBe(ABS_PATH); // an absolute path is left alone
  });

  it("keeps explicit nulls for the nullable keys", () => {
    const resolved = resolveRouting(
      cfgOf({ routing: { classifier: { model: null, baseUrl: null, apiKeyEnv: null }, outcomes: { path: null } } }),
      "v2",
    );
    expect(resolved.classifier.model).toBeNull();
    expect(resolved.outcomes.path).toBeNull();
  });
});

describe("resolveRouting — roles (D1, D12)", () => {
  beforeEach(() => resetRoutingWarnings());

  it("v2: roles {} disables native candidates (no class has an agent)", () => {
    const resolved = resolveRouting(cfgOf({ routing: { roles: {} } }), "v2");
    expect(resolved.roles).toEqual({});
    expect(Object.keys(resolved.roles)).toHaveLength(0);
    expect(resolved.applied.rolesSource).toBe("configured");
  });

  it("v2: explicit roles replace the default as a whole, they do not merge with it", () => {
    const resolved = resolveRouting(cfgOf({ routing: { roles: { search: ["scout"] } } }), "v2");
    expect(resolved.roles).toEqual({ search: ["scout"] });
  });

  it("v1: explicit roles are kept (the text-only opt-in) while the engine stays static", () => {
    const resolved = resolveRouting(cfgOf({ routing: { engine: "enforce", roles: { search: ["explore"] } } }), "v1");
    expect(resolved.roles).toEqual({ search: ["explore"] });
    expect(resolved.engine).toBe("static");
    expect(resolved.applied.rolesSource).toBe("configured");
  });

  it("v1: with no routing.roles there are no roles", () => {
    expect(resolveRouting(cfgOf({ routing: { engine: "shadow" } }), "v1").roles).toEqual({});
  });

  it("accepts roles naming agents that no preset or tier defines (native agents)", () => {
    const resolved = resolveRouting(cfgOf({ routing: { roles: { search: ["not-a-tier"] } } }), "v2");
    expect(resolved.roles.search).toEqual(["not-a-tier"]);
  });

  it("keeps an empty list for a class: that class has no native candidates", () => {
    const resolved = resolveRouting(cfgOf({ routing: { roles: { search: [], implement: ["general"] } } }), "v2");
    expect(resolved.roles).toEqual({ search: [], implement: ["general"] });
  });

  it("exports the task classes roles may name, and the D12 default uses only those", () => {
    expect(ROUTING_TASK_CLASSES).toEqual(["search", "recon", "mechanical", "implement", "debug", "design", "review", "other"]);
    for (const taskClass of Object.keys(DEFAULT_V2_ROLES)) {
      expect(ROUTING_TASK_CLASSES as readonly string[]).toContain(taskClass);
    }
  });

  it("does not let the shared v2 default be mutated through a result", () => {
    const first = resolveRouting(cfgOf(), "v2");
    expect(() => {
      (first.roles.search as string[]).push("x");
    }).toThrow(TypeError);
    expect(resolveRouting(cfgOf(), "v2").roles).toEqual(V2_DEFAULTS.roles);
  });
});

describe("resolveRouting — engine on v1 (D1)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetRoutingWarnings();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it.each(["shadow", "advise", "enforce"] as const)("coerces %s to static and says so, exactly once", (engine) => {
    const cfg = cfgOf({ routing: { engine } });
    const first = resolveRouting(cfg, "v1");
    resolveRouting(cfg, "v1");
    resolveRouting(cfg, "v1");
    expect(first.engine).toBe("static");
    expect(first.applied).toEqual({ host: "v1", requestedEngine: engine, engineCoerced: true, rolesSource: "none" });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith("[model-router] routing.engine ignored on OpenCode v1");
  });

  it("routes the single notice through the plugin logger when one is given", () => {
    const logger = { warn: vi.fn() };
    const cfg = cfgOf({ routing: { engine: "enforce" } });
    resolveRouting(cfg, "v1", logger);
    resolveRouting(cfg, "v1", logger);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(ROUTING_ENGINE_IGNORED_ON_V1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("says nothing when the engine is static or absent on v1", () => {
    resolveRouting(cfgOf({ routing: { engine: "static" } }), "v1");
    resolveRouting(cfgOf(), "v1");
    resolveRouting(undefined, "v1");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("says nothing on v2, whatever the engine", () => {
    for (const engine of ["static", "shadow", "advise", "enforce"] as const) {
      expect(resolveRouting(cfgOf({ routing: { engine } }), "v2").engine).toBe(engine);
    }
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("is re-armed by resetRoutingWarnings", () => {
    const cfg = cfgOf({ routing: { engine: "advise" } });
    resolveRouting(cfg, "v1");
    resetRoutingWarnings();
    resolveRouting(cfg, "v1");
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });
});

describe("resolveClassifierForPreset", () => {
  const classifierOf = (classifier: Record<string, unknown>) =>
    resolveRouting(cfgOf({ routing: { classifier } }), "v2").classifier;

  it("returns the classifier itself when the preset has no override", () => {
    const classifier = classifierOf({ backend: "host", model: "a/b", presets: { other: { model: "c/d" } } });
    expect(resolveClassifierForPreset(classifier, "anthropic")).toBe(classifier);
  });

  it("applies the override of the preset over the top-level backend and model", () => {
    const classifier = classifierOf({
      backend: "host",
      model: "a/b",
      timeoutMs: 2500,
      presets: { other: { model: "c/d#high" }, local: { backend: "rules" } },
    });
    expect(resolveClassifierForPreset(classifier, "other")).toMatchObject({
      backend: "host",
      model: "c/d#high",
      timeoutMs: 2500,
    });
    expect(resolveClassifierForPreset(classifier, "local")).toMatchObject({ backend: "rules", model: "a/b" });
  });

  it("lets an override clear the model with null", () => {
    const classifier = classifierOf({ backend: "host", model: "a/b", presets: { local: { backend: "rules", model: null } } });
    expect(resolveClassifierForPreset(classifier, "local").model).toBeNull();
  });

  it("matches preset names like /preset does: exact first, then case-insensitive and trimmed (QA-1.1-14)", () => {
    const classifier = classifierOf({ backend: "host", model: "a/b", presets: { Other: { model: "c/d" }, exact: { model: "e/f" } } });
    expect(resolveClassifierForPreset(classifier, "other").model).toBe("c/d");
    expect(resolveClassifierForPreset(classifier, "OTHER").model).toBe("c/d");
    expect(resolveClassifierForPreset(classifier, "  other ").model).toBe("c/d");
    expect(resolveClassifierForPreset(classifier, "exact").model).toBe("e/f");
    expect(resolveClassifierForPreset(classifier, "nothing")).toBe(classifier);
    expect(resolveClassifierForPreset(classifier, "")).toBe(classifier);
  });

  it("prefers an exact key over a case-insensitive one", () => {
    const classifier = classifierOf({ backend: "host", model: "a/b", presets: { other: { model: "lower/x" }, Other: { model: "upper/x" } } });
    expect(resolveClassifierForPreset(classifier, "Other").model).toBe("upper/x");
    expect(resolveClassifierForPreset(classifier, "other").model).toBe("lower/x");
  });

  it("never matches through the prototype", () => {
    const classifier = classifierOf({ backend: "host", model: "a/b", presets: { Other: { model: "c/d" } } });
    expect(resolveClassifierForPreset(classifier, "constructor")).toBe(classifier);
    expect(resolveClassifierForPreset(classifier, "toString")).toBe(classifier);
    expect(resolveClassifierForPreset(classifier, "__proto__")).toBe(classifier);
  });
  it("returns a frozen result", () => {
    const classifier = classifierOf({ backend: "host", model: "a/b", presets: { other: { model: "c/d" } } });
    expect(Object.isFrozen(resolveClassifierForPreset(classifier, "other"))).toBe(true);
  });
});

describe("resolveVariantSteps (A15, QA-1.1-4)", () => {
  const withSteps = (variantSteps: string, extra: Record<string, unknown> = {}) =>
    cfgOf({ enforcement: { escalate: { variantSteps } }, ...extra });

  it("is none on v2 when the config has no routing block: today's ladder, byte for byte (D2)", () => {
    expect(resolveVariantSteps(cfgOf(), "v2")).toBe("none");
    expect(resolveVariantSteps(undefined, "v2")).toBe("none");
    expect(resolveVariantSteps(cfgOf({ enforcement: { mode: "off" } }), "v2")).toBe("none");
    expect(resolveVariantSteps(cfgOf({ enforcement: { escalate: { effortBump: false } } }), "v2")).toBe("none");
  });

  it("is auto on v2 once the config has a routing block, even an empty one", () => {
    expect(resolveVariantSteps(cfgOf({ routing: {} }), "v2")).toBe("auto");
    expect(resolveVariantSteps(cfgOf({ routing: { engine: "static" } }), "v2")).toBe("auto");
    expect(resolveVariantSteps(cfgOf({ routing: { engine: "enforce" }, enforcement: { mode: "off" } }), "v2")).toBe("auto");
  });

  it("lets an explicit value win on v2, with or without a routing block", () => {
    expect(resolveVariantSteps(withSteps("auto"), "v2")).toBe("auto");
    expect(resolveVariantSteps(withSteps("none"), "v2")).toBe("none");
    expect(resolveVariantSteps(withSteps("none", { routing: {} }), "v2")).toBe("none");
    expect(resolveVariantSteps(withSteps("auto", { routing: {} }), "v2")).toBe("auto");
  });

  it("is always none on v1: variant steps are ignored there (D1)", () => {
    expect(resolveVariantSteps(withSteps("auto"), "v1")).toBe("none");
    expect(resolveVariantSteps(withSteps("auto", { routing: {} }), "v1")).toBe("none");
    expect(resolveVariantSteps(cfgOf({ routing: { engine: "enforce" } }), "v1")).toBe("none");
    expect(resolveVariantSteps(cfgOf(), "v1")).toBe("none");
    expect(resolveVariantSteps(undefined, "v1")).toBe("none");
  });

  it("follows the routing block through a hot reload of the global override", () => {
    // loadConfig() on the shipped tiers.json has no routing block.
    invalidateConfigCache();
    expect(resolveVariantSteps(loadConfig(), "v2")).toBe("none");
  });
});
describe("resolveCandidates", () => {
  it("returns exactly one entry for a tier without candidates: its own (model, variant, costRatio)", () => {
    const cfg = cfgOf();
    expect(resolveCandidates("fast", cfg)).toEqual([
      { model: "anthropic/claude-sonnet-5-5", variant: "low", costRatio: 1 },
    ]);
    expect(resolveCandidates("heavy", cfg)).toEqual([
      { model: "anthropic/claude-opus-5-5", variant: "xhigh", costRatio: 20 },
    ]);
  });

  it("omits variant for a tier that has none, and falls back to the conventional costRatio", () => {
    const cfg = cfgOf({
      presets: {
        anthropic: {
          fast: { model: "a/f" },
          medium: { model: "a/m" },
          heavy: { model: "a/h" },
          custom: { model: "a/c" },
        },
      },
    });
    const one = (tier: string) => resolveCandidates(tier, cfg);
    expect(one("fast")).toEqual([{ model: "a/f", costRatio: 1 }]);
    expect(one("medium")).toEqual([{ model: "a/m", costRatio: 5 }]);
    expect(one("heavy")).toEqual([{ model: "a/h", costRatio: 20 }]);
    expect(one("custom")).toEqual([{ model: "a/c", costRatio: 1 }]);
    expect("variant" in one("fast")[0]!).toBe(false);
  });

  it("returns the listed candidates in order, inheriting model and costRatio but not variant", () => {
    const cfg = cfgOf({
      presets: {
        anthropic: {
          medium: {
            model: "anthropic/claude-sonnet-5-5",
            variant: "medium",
            costRatio: 5,
            candidates: [
              { variant: "medium", costRatio: 5 },
              { variant: "high" },
              {},
              { model: "openai/gpt-6-luna", variant: "high", costRatio: 9 },
            ],
          },
        },
      },
    });
    expect(resolveCandidates("medium", cfg)).toEqual([
      { model: "anthropic/claude-sonnet-5-5", variant: "medium", costRatio: 5 },
      { model: "anthropic/claude-sonnet-5-5", variant: "high", costRatio: 5 },
      { model: "anthropic/claude-sonnet-5-5", costRatio: 5 },
      { model: "openai/gpt-6-luna", variant: "high", costRatio: 9 },
    ]);
  });

  it("resolves the documented example of the plan", () => {
    expect(resolveCandidates("medium", cfgOf())).toEqual([
      { model: "anthropic/claude-sonnet-5-5", variant: "medium", costRatio: 5 },
      { model: "anthropic/claude-sonnet-5-5", variant: "high", costRatio: 8 },
    ]);
  });

  it("treats an empty candidates list like an absent one", () => {
    const cfg = cfgOf({
      presets: { anthropic: { fast: { model: "a/f", variant: "low", costRatio: 2, candidates: [] } } },
    });
    expect(resolveCandidates("fast", cfg)).toEqual([{ model: "a/f", variant: "low", costRatio: 2 }]);
  });

  it("reads the active preset, matching its name case-insensitively like /preset does", () => {
    const cfg = cfgOf({ activePreset: "OTHER" });
    expect(resolveCandidates("fast", cfg)).toEqual([
      { model: "openai/gpt-6-luna-fast", variant: "medium", costRatio: 2 },
    ]);
  });

  it("returns an empty ladder, without throwing, for a tier the preset lacks", () => {
    const cfg = cfgOf({ activePreset: "other" });
    expect(resolveCandidates("heavy", cfg)).toEqual([]);
    expect(resolveCandidates("", cfg)).toEqual([]);
    expect(resolveCandidates("constructor", cfg)).toEqual([]);
    expect(resolveCandidates("toString", cfg)).toEqual([]);
  });

  it("ignores candidates that lack the tier's own rung: the ladder is the tier's own rung (QA-1.1-25)", () => {
    const cfg = cfgOf({
      presets: {
        anthropic: {
          medium: { model: "anthropic/claude-sonnet-5-5", variant: "xhigh", costRatio: 5, candidates: [{ variant: "medium" }, { variant: "high", costRatio: 8 }] },
        },
      },
    });
    expect(resolveCandidates("medium", cfg)).toEqual([{ model: "anthropic/claude-sonnet-5-5", variant: "xhigh", costRatio: 5 }]);
    expect(candidatesProblem("medium", cfg.presets.anthropic!.medium!)).toMatch(/does not contain the tier's own rung \(model anthropic\/claude-sonnet-5-5, variant xhigh\)/);
  });

  it("ignores candidates whose own rung states another costRatio (QA-1.1-25)", () => {
    const cfg = cfgOf({
      presets: {
        anthropic: {
          medium: { model: "anthropic/claude-sonnet-5-5", variant: "medium", costRatio: 5, candidates: [{ variant: "medium", costRatio: 6 }, { variant: "high", costRatio: 8 }] },
        },
      },
    });
    expect(resolveCandidates("medium", cfg)).toEqual([{ model: "anthropic/claude-sonnet-5-5", variant: "medium", costRatio: 5 }]);
    expect(collectRoutingNotices(undefined, cfg)).toEqual([
      "presets.anthropic.medium.candidates are ignored, the tier's ladder is its own rung: its own rung (candidates[0]) has costRatio 6, not the tier's 5",
    ]);
  });

  it("does not treat Object.prototype members as conventional tier names (QA-1.1-19)", () => {
    const cfg = cfgOf({
      presets: { anthropic: { constructor: { model: "a/c" }, toString: { model: "a/t" }, fast: { model: "a/f" } } },
    });
    expect(resolveCandidates("constructor", cfg)).toEqual([{ model: "a/c", costRatio: 1 }]);
    expect(resolveCandidates("toString", cfg)).toEqual([{ model: "a/t", costRatio: 1 }]);
  });

  it("returns an empty ladder when the active preset is unknown", () => {
    const cfg: RouterConfig = { ...cfgOf(), activePreset: "nope" };
    expect(resolveCandidates("fast", cfg)).toEqual([]);
  });

  it("returns frozen entries and a frozen array", () => {
    const ladder = resolveCandidates("medium", cfgOf());
    expect(Object.isFrozen(ladder)).toBe(true);
    for (const rung of ladder) expect(Object.isFrozen(rung)).toBe(true);
    expect(Object.isFrozen(resolveCandidates("nope", cfgOf()))).toBe(true);
  });

  it("does not depend on the routing block, and works on the shipped tiers.json", () => {
    invalidateConfigCache();
    const cfg = loadConfig();
    const tier = cfg.presets[cfg.activePreset]!.medium!;
    const ladder = resolveCandidates("medium", cfg);
    expect(ladder).toHaveLength(1);
    expect(ladder[0]).toMatchObject({ model: tier.model, costRatio: tier.costRatio });
  });
});

describe("the shipped tiers.json (no routing block: behaviour unchanged)", () => {
  beforeEach(() => resetRoutingWarnings());

  it("has no routing, no candidates and no variantSteps", () => {
    const raw: unknown = JSON.parse(readFileSync(join(ROOT, "tiers.json"), "utf-8"));
    expect(raw).not.toHaveProperty("routing");
    expect(raw).not.toHaveProperty("enforcement.escalate.variantSteps");
    for (const preset of Object.values((raw as { presets: Record<string, Record<string, object>> }).presets)) {
      for (const tier of Object.values(preset)) expect(tier).not.toHaveProperty("candidates");
    }
  });

  it("resolves to the static engine with the documented defaults on both hosts", () => {
    invalidateConfigCache();
    const cfg = loadConfig();
    expect(cfg.routing).toBeUndefined();
    expect(resolveRouting(cfg, "v2")).toEqual(V2_DEFAULTS);
    expect(resolveRouting(cfg, "v1")).toEqual(V1_DEFAULTS);
  });
});

describe("findUnknownRoutingKeys / collectRoutingNotices (QA-1.1-10, -14, -18)", () => {
  it("has no notices for a directory whose config was never loaded", () => {
    expect(getConfigNotices(join(tmpdir(), "oc-mr-never-loaded-dir"))).toEqual([]);
  });

  it("lists the path of every unknown key, at every level", () => {
    expect(
      findUnknownRoutingKeys({
        engine: "shadow",
        margn: 0.5,
        detection: { det: 1, grader: 0.5 },
        classifier: { bakend: "host", presets: { anthropic: { modle: "a/b", model: "c/d" } } },
        outcomes: { pth: "x" },
        sessionReuse: { max: 1 },
        advisor: { enable: false },
      }),
    ).toEqual([
      "routing.margn",
      "routing.detection.det",
      "routing.classifier.bakend",
      "routing.outcomes.pth",
      "routing.sessionReuse.max",
      "routing.advisor.enable",
      "routing.classifier.presets.anthropic.modle",
    ]);
  });

  it("skips a classifier.presets entry that is not an object (validation reports that, not the notice)", () => {
    expect(findUnknownRoutingKeys({ classifier: { presets: { a: "host", b: null, c: { modle: "x/y" } } } })).toEqual([
      "routing.classifier.presets.c.modle",
    ]);
  });

  it("finds none in a clean block, an absent block, or a block of the wrong type", () => {
    expect(findUnknownRoutingKeys(undefined)).toEqual([]);
    expect(findUnknownRoutingKeys(null)).toEqual([]);
    expect(findUnknownRoutingKeys("shadow")).toEqual([]);
    expect(findUnknownRoutingKeys([])).toEqual([]);
    expect(findUnknownRoutingKeys({ engine: "static", roles: { anything: [] }, classifier: { presets: {} } })).toEqual([]);
  });

  it("reports unknown keys in one notice, singular or plural", () => {
    const cfg = cfgOf();
    expect(collectRoutingNotices({ margn: 1 }, cfg)).toEqual(["ignoring unknown routing key: routing.margn"]);
    expect(collectRoutingNotices({ margn: 1, profil: "x" }, cfg)).toEqual([
      "ignoring unknown routing keys: routing.margn, routing.profil",
    ]);
  });

  it("notices roles that name the built-in primary/internal agents, and accepts them", () => {
    expect([...ROUTING_RESERVED_AGENTS]).toEqual(["build", "plan", "title", "summary", "compaction"]);
    const cfg = cfgOf({
      routing: { roles: { search: ["explore", "build"], implement: ["plan", "general"], review: ["title", "summary", "compaction"] } },
    });
    const messages = collectRoutingNotices(cfg.routing, cfg);
    expect(messages).toHaveLength(5);
    for (const name of ["build", "plan", "title", "summary", "compaction"]) {
      expect(messages.some((m) => m.includes(`names '${name}'`))).toBe(true);
    }
    expect(messages[0]).toMatch(/^routing\.roles\.'search' names 'build', an OpenCode primary\/internal agent that cannot be a subagent; it will be skipped$/);
    expect(resolveRouting(cfg, "v2").roles.search).toEqual(["explore", "build"]); // the engine skips it
  });

  it("does not notice ordinary agents, including look-alikes", () => {
    const cfg = cfgOf({ routing: { roles: { search: ["explore", "builder", "Build", "planner"] } } });
    expect(collectRoutingNotices(cfg.routing, cfg)).toEqual([]);
  });

  it("notices a per-preset classifier override that matches no preset, matching names like /preset does", () => {
    const cfg = cfgOf({
      routing: {
        classifier: { backend: "host", model: "a/b", presets: { ANTHROPIC: { model: "c/d" }, nosuch: { model: "e/f" } } },
      },
    });
    expect(collectRoutingNotices(cfg.routing, cfg)).toEqual([
      "routing.classifier.presets.'nosuch' matches no preset (defined: anthropic, other); the override is unused",
    ]);
  });

  it("has nothing to say about a config without routing", () => {
    expect(collectRoutingNotices(undefined, cfgOf())).toEqual([]);
  });
});
describe("hasExplicitCandidates (QA-1.1-11)", () => {
  it("is true only for a non-empty candidates array", () => {
    expect(hasExplicitCandidates({ model: "a/b" })).toBe(false);
    expect(hasExplicitCandidates({ model: "a/b", candidates: [] })).toBe(false);
    expect(hasExplicitCandidates({ model: "a/b", candidates: [{}] })).toBe(true);
    expect(hasExplicitCandidates({ model: "a/b", candidates: [{ variant: "high" }, {}] })).toBe(true);
  });

  it("agrees with resolveCandidates on the shipped example and on a plain tier", () => {
    const cfg = cfgOf();
    expect(hasExplicitCandidates(cfg.presets.anthropic!.medium!)).toBe(true);
    expect(resolveCandidates("medium", cfg).length).toBeGreaterThan(1);
    expect(hasExplicitCandidates(cfg.presets.anthropic!.plain!)).toBe(false);
    expect(resolveCandidates("plain", cfg)).toHaveLength(1);
  });
});
// ---------------------------------------------------------------------------
// Hot reload (1.1.4; phase 0.P handoff "to 1.1", amendment A6): the global
// override file is where the dogfood checkpoints edit `routing.*`.
// ---------------------------------------------------------------------------

describe("hot reload of the global override file with a routing block", () => {
  // The temporary home, the env redirect, the os.homedir() mock and the guard
  // come from the file-level hooks above.
  let warnSpy: ReturnType<typeof vi.spyOn>;
  /** Stands in for the plugin logger: where config notices go (QA-1.1-23). */
  let logger = { warn: vi.fn() };
  /** loadConfig + what the plugin does after every load: log the new notices through the logger. */
  const reload = (dir?: string): RouterConfig => {
    const cfg = loadConfig(dir);
    warnConfigNotices(cfg, logger);
    return cfg;
  };
  /** Messages given to the logger that contain `needle`. */
  const logged = (needle: string): string[] =>
    logger.warn.mock.calls.map((c: unknown[]) => String(c[0])).filter((m: string) => m.includes(needle));

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logger = { warn: vi.fn() };
    resetRoutingWarnings();
    invalidateConfigCache();
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  /** Write the global override WITHOUT invalidating the cache, bumping its mtime like a real edit. */
  let tick = 0;
  function editOverride(content: unknown): void {
    const p = overridePath();
    assertInsideTmpHome(p); // belt and braces: never write outside the temporary home
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content), "utf-8");
    const later = new Date(Date.now() + 60_000 * ++tick);
    utimesSync(p, later, later);
  }

  it("picks up a routing block added, changed and removed, with no explicit invalidate", () => {
    const first = loadConfig();
    expect(first.routing).toBeUndefined();

    editOverride({ routing: { engine: "shadow", margin: 0.3 } });
    const second = loadConfig();
    expect(second).not.toBe(first);
    expect(second.routing).toEqual({ engine: "shadow", margin: 0.3 });
    expect(resolveRouting(second, "v2")).toMatchObject({ engine: "shadow", margin: 0.3, profile: "balanced" });

    editOverride({ routing: { engine: "advise", profile: "safe", margin: 0.35 } });
    const third = loadConfig();
    expect(third).not.toBe(second);
    expect(resolveRouting(third, "v2")).toMatchObject({ engine: "advise", profile: "safe", margin: 0.35 });

    unlinkSync(overridePath());
    const fourth = loadConfig();
    expect(fourth.routing).toBeUndefined();
    expect(resolveRouting(fourth, "v2").engine).toBe("static");
    expect(getConfigReloadError()).toBeNull();
  });

  it("serves the identical object while the override is unchanged", () => {
    editOverride({ routing: { engine: "shadow" } });
    expect(loadConfig()).toBe(loadConfig());
  });

  it("returns candidates and variantSteps from the override layer too", () => {
    const first = loadConfig();
    const presetName = first.activePreset;
    const tier = first.presets[presetName]!.medium!;
    const own = tier.variant === undefined ? {} : { variant: tier.variant };
    editOverride({
      presets: { [presetName]: { medium: { candidates: [own, { variant: "high", costRatio: 9 }] } } },
      enforcement: { escalate: { variantSteps: "none" } },
    });
    const next = loadConfig();
    expect(next).not.toBe(first);
    expect(getConfigReloadError()).toBeNull();
    expect(resolveVariantSteps(next, "v2")).toBe("none");
    expect(resolveCandidates("medium", next)).toEqual([
      { model: tier.model, ...own, costRatio: tier.costRatio },
      { model: tier.model, variant: "high", costRatio: 9 },
    ]);
  });

  it("keeps an override that sets candidates when the tier's variant later changes: candidates ignored with a notice, the rest of the layer applies (QA-1.1-25)", () => {
    const first = loadConfig();
    const presetName = first.activePreset;
    const tier = first.presets[presetName]!.medium!;
    const own = tier.variant === undefined ? {} : { variant: tier.variant };
    const candidates = [own, { variant: "high", costRatio: 9 }];
    editOverride({ presets: { [presetName]: { medium: { candidates } } }, routing: { engine: "shadow" } });
    reload();
    expect(resolveCandidates("medium", loadConfig())).toHaveLength(2);
    expect(getConfigNotices().map((n) => n.message)).toEqual([]);

    // The bundled tier's variant moves (here: the override moves it, as a plugin update would):
    // the list no longer contains the tier's own rung.
    editOverride({ presets: { [presetName]: { medium: { variant: "moved-variant", candidates } } }, routing: { engine: "shadow" } });
    const next = reload();
    expect(getConfigReloadError()).toBeNull();
    expect(resolveRouting(next, "v2").engine).toBe("shadow"); // the layer was not dropped
    expect(resolveCandidates("medium", next)).toEqual([{ model: tier.model, variant: "moved-variant", costRatio: tier.costRatio }]);
    expect(getConfigNotices().map((n) => n.message)).toEqual([
      `presets.${presetName}.medium.candidates are ignored, the tier's ladder is its own rung: it does not contain the tier's own rung (model ${tier.model}, variant moved-variant)`,
    ]);
    expect(logged("candidates are ignored")).toHaveLength(1);
  });

  describe("an ignored candidates list is removed from the built config (QA-1.1-30)", () => {
    const loadMedium = (mediumPatch: Record<string, unknown>) => {
      const first = loadConfig();
      const presetName = first.activePreset;
      editOverride({ presets: { [presetName]: { medium: mediumPatch } } });
      const cfg = reload();
      return { cfg, presetName, tier: cfg.presets[presetName]!.medium! };
    };

    it("a list without the tier's own rung: notice, no tier.candidates, hasExplicitCandidates false, one-rung ladder", () => {
      const { cfg, tier } = loadMedium({ variant: "kept-variant", candidates: [{ variant: "other" }, { variant: "higher", costRatio: 9 }] });
      expect(getConfigNotices().map((n) => n.message)).toEqual([
        expect.stringContaining("candidates are ignored, the tier's ladder is its own rung: it does not contain the tier's own rung"),
      ]);
      expect(logged("candidates are ignored")).toHaveLength(1);
      expect(tier.candidates).toBeUndefined();
      expect("candidates" in tier).toBe(false);
      expect(hasExplicitCandidates(tier)).toBe(false);
      expect(resolveCandidates("medium", cfg)).toEqual([{ model: tier.model, variant: "kept-variant", costRatio: tier.costRatio }]);
      expect(candidatesProblem("medium", tier)).toBeUndefined(); // nothing left to be a problem
    });

    it("a list whose own rung states another costRatio: the same", () => {
      const { cfg, tier } = loadMedium({
        variant: "kept-variant",
        costRatio: 5,
        candidates: [{ variant: "kept-variant", costRatio: 6 }, { variant: "higher", costRatio: 9 }],
      });
      expect(getConfigNotices().map((n) => n.message)).toEqual([
        expect.stringContaining("its own rung (candidates[0]) has costRatio 6, not the tier's 5"),
      ]);
      expect(tier.candidates).toBeUndefined();
      expect(hasExplicitCandidates(tier)).toBe(false);
      expect(resolveCandidates("medium", cfg)).toEqual([{ model: tier.model, variant: "kept-variant", costRatio: 5 }]);
    });

    it("keeps a list that is used, and leaves other tiers alone", () => {
      const { cfg, tier } = loadMedium({ variant: "kept-variant", costRatio: 5, candidates: [{ variant: "kept-variant" }, { variant: "higher", costRatio: 9 }] });
      expect(getConfigNotices()).toEqual([]);
      expect(tier.candidates).toHaveLength(2);
      expect(hasExplicitCandidates(tier)).toBe(true);
      expect(resolveCandidates("medium", cfg)).toHaveLength(2);
    });

    it("does not touch the caller's object when a config is validated directly", () => {
      const raw = rawConfig({
        presets: { anthropic: { medium: { model: "anthropic/claude-sonnet-5-5", variant: "x", costRatio: 5, candidates: [{ variant: "y" }] } } },
      });
      const cfg = validateConfig(raw);
      expect(cfg.presets.anthropic!.medium!.candidates).toHaveLength(1); // only loading drops it
      expect(candidatesProblem("medium", cfg.presets.anthropic!.medium!)).toBeDefined();
    });
  });

  it("still drops a layer whose candidates are malformed (a malformed entry is an error, not a notice)", () => {
    const first = loadConfig();
    const presetName = first.activePreset;
    editOverride({ presets: { [presetName]: { medium: { candidates: [{ variant: "high", costRatio: "x" }] } } }, routing: { engine: "shadow" } });
    const next = loadConfig();
    expect(next.routing).toBeUndefined(); // the whole layer was dropped
    expect(warnSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes("costRatio"))).toBe(true);
  });

  it("merges the project layer over the global one key by key", () => {
    const project = mkdtempSync(join(tmpdir(), "oc-mr-routing-proj-"));
    try {
      mkdirSync(join(project, ".git"), { recursive: true });
      mkdirSync(join(project, ".opencode"), { recursive: true });
      editOverride({ routing: { engine: "shadow", margin: 0.3, roles: { search: ["explore"] } } });
      writeFileSync(
        join(project, ".opencode", "opencode-model-router.overrides.jsonc"),
        '{ "routing": { "engine": "advise" } } // project wins for the engine only',
        "utf-8",
      );
      invalidateConfigCache();
      const merged = resolveRouting(loadConfig(project), "v2");
      expect(merged).toMatchObject({ engine: "advise", margin: 0.3, roles: { search: ["explore"] } });
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("replaces roles wholesale across layers instead of merging per class (QA-1.1-7)", () => {
    const project = mkdtempSync(join(tmpdir(), "oc-mr-routing-roles-"));
    try {
      mkdirSync(join(project, ".git"), { recursive: true });
      mkdirSync(join(project, ".opencode"), { recursive: true });
      editOverride({ routing: { roles: { search: ["explore"], implement: ["general"], review: ["general"] } } });
      // Global alone.
      expect(resolveRouting(loadConfig(project), "v2").roles).toEqual({
        search: ["explore"],
        implement: ["general"],
        review: ["general"],
      });
      // A project layer that sets roles replaces the whole map: no search, no review.
      writeFileSync(
        join(project, ".opencode", "opencode-model-router.overrides.jsonc"),
        JSON.stringify({ routing: { roles: { debug: ["general"], implement: [] } } }),
        "utf-8",
      );
      invalidateConfigCache();
      expect(resolveRouting(loadConfig(project), "v2").roles).toEqual({ debug: ["general"], implement: [] });
      // A project layer that does not mention roles leaves the global map alone.
      writeFileSync(
        join(project, ".opencode", "opencode-model-router.overrides.jsonc"),
        JSON.stringify({ routing: { margin: 0.4 } }),
        "utf-8",
      );
      invalidateConfigCache();
      expect(resolveRouting(loadConfig(project), "v2").roles).toEqual({
        search: ["explore"],
        implement: ["general"],
        review: ["general"],
      });
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("a layer with roles {} disables every native candidate, whatever the layers below say", () => {
    editOverride({ routing: { roles: { search: ["explore"] } } });
    const project = mkdtempSync(join(tmpdir(), "oc-mr-routing-roles-"));
    try {
      mkdirSync(join(project, ".git"), { recursive: true });
      mkdirSync(join(project, ".opencode"), { recursive: true });
      writeFileSync(join(project, ".opencode", "opencode-model-router.overrides.jsonc"), JSON.stringify({ routing: { roles: {} } }), "utf-8");
      invalidateConfigCache();
      expect(resolveRouting(loadConfig(project), "v2").roles).toEqual({});
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("keeps the last valid config, and reports why, when the edited routing block is invalid", () => {
    editOverride({ routing: { engine: "shadow" } });
    const good = loadConfig();
    expect(resolveRouting(good, "v2").engine).toBe("shadow");

    editOverride({ routing: { engine: "shadow", margin: 5 } });
    const after = loadConfig();
    expect(after).toBe(good);
    expect(getConfigReloadError()).toMatch(/routing\.margin must be a number >= 0 and <= 0.9/);

    editOverride({ routing: { engine: "enforce", margin: 0.2 } });
    expect(resolveRouting(loadConfig(), "v2").engine).toBe("enforce");
    expect(getConfigReloadError()).toBeNull();
  });

  it("drops an override whose routing block is invalid at first load, falling back to the bundled config", () => {
    editOverride({ routing: { classifier: { backend: "host" } } });
    const cfg = loadConfig();
    expect(cfg.routing).toBeUndefined();
    expect(warnSpy.mock.calls.some((call: unknown[]) => String(call[0]).includes("routing.classifier.model"))).toBe(true);
  });

  it("accepts the DF3 classifier shape from the global override (phase 0.P handoff)", () => {
    editOverride({
      routing: { classifier: { backend: "host", model: "opencode-go/deepseek-v4.1-flash", timeoutMs: 10000 } },
    });
    const resolved = resolveRouting(loadConfig(), "v2");
    expect(resolved.classifier).toMatchObject({
      backend: "host",
      model: "opencode-go/deepseek-v4.1-flash",
      timeoutMs: 10000,
    });
    expect(getConfigReloadError()).toBeNull();
  });

  describe("config notices through loadConfig (QA-1.1-10, -14, -18, -23)", () => {
    const noticeMessages = (): string[] => getConfigNotices().map((n) => n.message);
    const consoleNotices = (): string[] =>
      warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).filter((m: string) => m.includes("routing key"));

    it("loads a config with unknown routing keys, lists them, and logs them once through the logger", () => {
      editOverride({ routing: { engine: "shadow", margn: 0.5, classifier: { bakend: "host" }, outcomes: { pth: "x" } } });
      const cfg = reload();
      expect(resolveRouting(cfg, "v2").engine).toBe("shadow");
      expect(getConfigReloadError()).toBeNull();
      expect(noticeMessages()).toEqual([
        "ignoring unknown routing keys: routing.margn, routing.classifier.bakend, routing.outcomes.pth",
      ]);
      expect(logged("ignoring unknown routing keys")).toEqual([
        "ignoring unknown routing keys: routing.margn, routing.classifier.bakend, routing.outcomes.pth",
      ]);
      // Same files, rebuilt: not again.
      invalidateConfigCache();
      reload();
      expect(logged("ignoring unknown routing keys")).toHaveLength(1);
    });

    it("never writes a notice to the console itself: loading is silent, the plugin logs", () => {
      editOverride({ routing: { margn: 0.5 } });
      loadConfig();
      invalidateConfigCache();
      loadConfig();
      expect(consoleNotices()).toEqual([]);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("logs a notice once per text: a state write and two more reloads do not repeat it (QA-1.1-23)", () => {
      editOverride({ routing: { margn: 0.5 } });
      const first = reload();
      expect(logged("routing.margn")).toHaveLength(1);

      // /preset, /budget, /router enforce … write the state file: a new fingerprint, a rebuilt config.
      writeState({ activePreset: "openai" });
      const second = reload();
      expect(second).not.toBe(first);
      invalidateConfigCache();
      const third = reload();
      expect(third).not.toBe(second);

      expect(logged("routing.margn")).toHaveLength(1);
      expect(consoleNotices()).toEqual([]);
    });

    it("does not repeat the text when the file changes but the typo stays, and logs a different text when another appears", () => {
      editOverride({ routing: { margn: 0.5 } });
      reload();
      editOverride({ routing: { margn: 0.5, engine: "advise" } });
      reload();
      expect(logged("ignoring unknown routing key")).toEqual(["ignoring unknown routing key: routing.margn"]);
      editOverride({ routing: { margn: 0.5, profil: "safe" } });
      reload();
      expect(logged("ignoring unknown routing key")).toEqual([
        "ignoring unknown routing key: routing.margn",
        "ignoring unknown routing keys: routing.margn, routing.profil",
      ]);
    });

    it("keeps logging correctly across hundreds of distinct notices (the logged-text set is bounded)", () => {
      for (let i = 0; i < 260; i++) {
        editOverride({ routing: { [`typo${i}`]: 1 } });
        reload();
      }
      expect(logged("ignoring unknown routing key: routing.typo")).toHaveLength(260);
      expect(noticeMessages()).toEqual(["ignoring unknown routing key: routing.typo259"]);
    });

    it("passes the source file along with a notice that concerns one", () => {
      const project = mkdtempSync(join(tmpdir(), "oc-mr-routing-src-"));
      try {
        mkdirSync(join(project, ".git"), { recursive: true });
        mkdirSync(join(project, ".opencode"), { recursive: true });
        const file = join(project, ".opencode", "opencode-model-router.overrides.jsonc");
        writeFileSync(file, JSON.stringify({ routing: { classifier: { baseUrl: "http://evil.example/v1" } } }), "utf-8");
        reload(project);
        const call = logger.warn.mock.calls.find((c: unknown[]) => String(c[0]).includes("only the global override may set it"));
        expect(call).toBeDefined();
        expect((call![1] as { source: string }).source).toContain(".opencode");
      } finally {
        rmSync(project, { recursive: true, force: true });
      }
    });

    it("drops the notice once the typo is fixed", () => {
      editOverride({ routing: { margn: 0.5 } });
      loadConfig();
      expect(noticeMessages()).toHaveLength(1);
      editOverride({ routing: { margin: 0.5 } });
      expect(loadConfig().routing?.margin).toBe(0.5);
      expect(noticeMessages()).toEqual([]);
    });

    it("notices roles naming primary agents and classifier presets matching no preset; resolves a preset key case-insensitively", () => {
      editOverride({
        routing: {
          roles: { search: ["build"] },
          classifier: { backend: "host", model: "a/b", presets: { nosuch: { model: "c/d" }, ANTHROPIC: { model: "e/f" } } },
        },
      });
      const cfg = loadConfig();
      const messages = noticeMessages();
      expect(messages).toHaveLength(2);
      expect(messages[0]).toContain("routing.roles.'search' names 'build'");
      expect(messages[1]).toContain("routing.classifier.presets.'nosuch' matches no preset");
      const classifier = resolveRouting(cfg, "v2").classifier;
      expect(resolveClassifierForPreset(classifier, cfg.activePreset).model).toBe("e/f");
    });

    it("keeps the notices of the last good build when a reload fails", () => {
      editOverride({ routing: { margn: 0.5 } });
      const good = loadConfig();
      editOverride({ routing: { margin: 7 } });
      expect(loadConfig()).toBe(good);
      expect(noticeMessages()).toEqual(["ignoring unknown routing key: routing.margn"]);
    });

    it("logs nothing for a config that did not come from loadConfig (it carries no notices)", () => {
      warnConfigNotices(cfgOf({ routing: { margn: 1 } }), logger);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("logs nothing for a config without notices, or when given no config", () => {
      editOverride({ routing: { engine: "shadow" } });
      reload();
      warnConfigNotices(undefined, logger);
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });
  describe("project layer trust (A18, QA-1.1-2)", () => {
    let project: string;
    const projectFile = (): string => join(project, ".opencode", "opencode-model-router.overrides.jsonc");
    const writeProject = (data: unknown): void => {
      writeFileSync(projectFile(), JSON.stringify(data), "utf-8");
      invalidateConfigCache();
    };
    const projectWarnings = (): string[] => logged("only the global override may set it");

    beforeEach(() => {
      project = mkdtempSync(join(tmpdir(), "oc-mr-routing-proj-"));
      mkdirSync(join(project, ".git"), { recursive: true });
      mkdirSync(join(project, ".opencode"), { recursive: true });
    });

    afterEach(() => {
      rmSync(project, { recursive: true, force: true });
    });

    it("drops classifier.{backend,model,baseUrl,apiKeyEnv,presets} and outcomes.path from the project layer, keeps the other keys, warns once", () => {
      writeProject({
        routing: {
          engine: "advise",
          margin: 0.3,
          roles: { search: ["explore"] },
          classifier: {
            backend: "openai-compatible",
            model: "evil/model",
            baseUrl: "http://evil.example/v1",
            apiKeyEnv: "SECRET",
            presets: { anthropic: { model: "evil/other" } },
            timeoutMs: 1000,
          },
          outcomes: { path: resolve(tmpdir(), "stolen"), halfLifeDays: 20 },
        },
      });
      const resolved = resolveRouting(reload(project), "v2");
      expect(resolved.classifier).toMatchObject({
        backend: "rules",
        model: null,
        baseUrl: null,
        apiKeyEnv: null,
        presets: {},
        timeoutMs: 1000, // a project may tighten the default budget
      });
      expect(resolved.outcomes).toMatchObject({ path: null, halfLifeDays: 20 });
      expect(resolved).toMatchObject({ engine: "advise", margin: 0.3, roles: { search: ["explore"] } });

      const warnings = projectWarnings();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(
        "ignoring routing.classifier.backend, routing.classifier.model, routing.classifier.baseUrl, routing.classifier.apiKeyEnv, routing.classifier.presets, routing.outcomes.path from ",
      );
      expect(warnings[0]).toContain(projectFile());
      expect(warnings[0]).toMatch(/: only the global override may set it$/);
      expect(getConfigNotices(project).map((n) => n.message)).toEqual([warnings[0]]);
      expect(warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).filter((m: string) => m.includes("only the global override"))).toEqual([]);

      // Same files, rebuilt: logged once, not again.
      invalidateConfigCache();
      reload(project);
      expect(projectWarnings()).toHaveLength(1);
    });

    it("says `routing.classifier.baseUrl` in the message of a lone baseUrl", () => {
      writeProject({ routing: { classifier: { baseUrl: "http://evil.example/v1" } } });
      expect(resolveRouting(reload(project), "v2").classifier.baseUrl).toBeNull();
      expect(projectWarnings()[0]).toMatch(/^ignoring routing\.classifier\.baseUrl from .+: only the global override may set it$/);
    });

    it("lets the global layer set them, and the project layer cannot override the global values", () => {
      editOverride({
        routing: {
          classifier: { backend: "openai-compatible", model: "global/model", baseUrl: "https://global.example/v1", apiKeyEnv: "GLOBAL_KEY" },
          outcomes: { path: resolve(tmpdir(), "global-outcomes") },
        },
      });
      writeProject({
        routing: { classifier: { model: "evil/model", baseUrl: "http://evil.example/v1" }, outcomes: { path: resolve(tmpdir(), "evil") } },
      });
      const resolved = resolveRouting(loadConfig(project), "v2");
      expect(resolved.classifier).toMatchObject({
        backend: "openai-compatible",
        model: "global/model",
        baseUrl: "https://global.example/v1",
        apiKeyEnv: "GLOBAL_KEY",
      });
      expect(resolved.outcomes.path).toBe(resolve(tmpdir(), "global-outcomes"));
    });

    it("D14 A18/A35 QA-G-B5: p9 cannot widen classifier budgets or redirect the backend, but may select engine/profile/margin", () => {
      editOverride({ routing: { engine: "advise", classifier: {
        backend: "openai-compatible", model: "acme/small", baseUrl: "https://classifier.example.com/v1", apiKeyEnv: "ACME_KEY",
        maxStateChars: 500, timeoutMs: 1500, samples: 1,
      } } });
      writeProject({ routing: { engine: "enforce", margin: 0, profile: "frugal", classifier: {
        backend: "openai-compatible", model: "evil/x", baseUrl: "https://evil.example.com/v1", apiKeyEnv: "OTHER",
        maxStateChars: 20000, timeoutMs: 30000, samples: 3,
      }, outcomes: { path: resolve(tmpdir(), "evil") } } });
      const resolved = resolveRouting(reload(project), "v2");
      expect(resolved.classifier).toMatchObject({ backend: "openai-compatible", model: "acme/small",
        baseUrl: "https://classifier.example.com/v1", apiKeyEnv: "ACME_KEY", maxStateChars: 500, timeoutMs: 1500, samples: 1 });
      expect(resolved).toMatchObject({ engine: "enforce", margin: 0, profile: "frugal", outcomes: { path: null } });
      expect(logged("A18: clamping")).toHaveLength(3);
      for (const key of ["maxStateChars", "samples", "timeoutMs"]) {
        expect(logged("A18: clamping").some((m) => m.includes(`routing.classifier.${key}`) && m.includes(projectFile()))).toBe(true);
      }
      invalidateConfigCache();
      reload(project);
      expect(logged("A18: clamping")).toHaveLength(3);
    });

    it("A35 clamps to defaults without a global budget and allows tighter project values", () => {
      writeProject({ routing: { classifier: { maxStateChars: 20000, timeoutMs: 30000, samples: 3 } } });
      expect(resolveRouting(reload(project), "v2").classifier).toMatchObject({ maxStateChars: 2000, timeoutMs: 1500, samples: 1 });
      editOverride({ routing: { classifier: { maxStateChars: 4000, timeoutMs: 3000, samples: 3 } } });
      writeProject({ routing: { classifier: { maxStateChars: 300, timeoutMs: 100, samples: 1 } } });
      expect(resolveRouting(reload(project), "v2").classifier).toMatchObject({ maxStateChars: 300, timeoutMs: 100, samples: 1 });
      expect(getConfigNotices(project)).toEqual([]);
    });

    it.each(["500", 100, 20_001, 500.5])("R2-3: invalid inherited maxStateChars %s uses the default ceiling", (maxStateChars) => {
      editOverride({ routing: { classifier: { maxStateChars } } });
      writeProject({ routing: { classifier: { maxStateChars: 8000 } } });
      expect(resolveRouting(reload(project), "v2").classifier.maxStateChars).toBe(2000);
      expect(logged("A18: clamping").some((message) => message.includes("maxStateChars") && message.includes("2000"))).toBe(true);
    });

    it("has nothing to strip, and nothing to say, when the project layer has no routing block", () => {
      writeProject({ tierCaps: { fast: 9 } });
      expect(loadConfig(project).tierCaps?.fast).toBe(9);
      writeProject({ routing: "not an object" });
      expect(getConfigReloadError(project)).toBeNull();
      reload(project); // the layer is invalid as a whole and is dropped; the strip must not throw first
      expect(projectWarnings()).toHaveLength(0);
    });

    it("removes the blocks (and an emptied routing) that stripping leaves empty, so a forbidden-only project file cannot switch variant steps on (QA-1.1-24)", () => {
      writeProject({ routing: { classifier: { baseUrl: "http://evil.example/v1", model: "evil/model" }, outcomes: { path: resolve(tmpdir(), "x") } } });
      const cfg = reload(project);
      expect(cfg.routing).toBeUndefined();
      expect(resolveVariantSteps(cfg, "v2")).toBe("none"); // no routing block anywhere: the 2.2.0 ladder
      expect(projectWarnings()).toHaveLength(1);
    });

    it("keeps an emptied classifier/outcomes block out of the merge but leaves the other routing keys (and the block) alone", () => {
      writeProject({ routing: { engine: "shadow", classifier: { baseUrl: "http://evil.example/v1" }, outcomes: { path: resolve(tmpdir(), "x") } } });
      const cfg = reload(project);
      expect(cfg.routing).toEqual({ engine: "shadow" });
      expect(resolveVariantSteps(cfg, "v2")).toBe("auto"); // the author did write a routing block
    });

    it("keeps a classifier block that still has allowed keys, and an explicitly empty routing block of the project file", () => {
      writeProject({ routing: { classifier: { baseUrl: "http://evil.example/v1", timeoutMs: 2500 } } });
      expect(reload(project).routing).toEqual({ classifier: { timeoutMs: 1500 } });
      writeProject({ routing: {} });
      const cfg = reload(project);
      expect(cfg.routing).toEqual({});
      expect(resolveVariantSteps(cfg, "v2")).toBe("auto"); // an explicit empty block is still a block
    });

    it("says nothing about a project layer that does not set them", () => {
      writeProject({ routing: { engine: "shadow", classifier: { timeoutMs: 1000 } } });
      expect(resolveRouting(reload(project), "v2")).toMatchObject({ engine: "shadow" });
      expect(projectWarnings()).toHaveLength(0);
      expect(getConfigNotices(project)).toEqual([]);
    });

    it("still drops them when the rest of the project layer is what makes it valid", () => {
      // classifier.backend "host" without a model would be rejected as a layer; with the
      // global-only keys removed first, the remaining valid keys of the layer apply.
      writeProject({ routing: { engine: "shadow", classifier: { backend: "host" } } });
      expect(resolveRouting(loadConfig(project), "v2")).toMatchObject({ engine: "shadow" });
      expect(getConfigReloadError(project)).toBeNull();
    });
  });

  describe("through the /router command", () => {
    type CommandHook = (
      input: { command: string; arguments: string },
      output: { parts: Array<{ type: string; text?: string }> },
    ) => Promise<void>;

    async function runRouter(routerHost: "v2" | undefined, args = ""): Promise<string> {
      const ctx = (routerHost ? { routerHost } : {}) as unknown as Parameters<typeof ModelRouterPlugin>[0];
      const hooks = await ModelRouterPlugin(ctx);
      const hook = hooks["command.execute.before"] as unknown as CommandHook;
      const out = { parts: [] as Array<{ type: string; text?: string }> };
      await hook({ command: "router", arguments: args }, out);
      return out.parts.map((p) => p.text ?? "").join("\n");
    }

    const markerLines = (text: string): string[] => text.split("\n").filter((l) => l.startsWith("router: engine="));
    const MARKER = /^router: engine=(static|shadow|advise|enforce) build=\d+\.\d+\.\d+(?:[-+.\w]*)\+([0-9a-f]{7}|unknown)$/;

    it("prints exactly one `router: engine=… build=…` line on the bare status view", async () => {
      const lines = markerLines(await runRouter("v2"));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(MARKER);
      expect(lines[0]).toBe(formatRouterLine("static"));
    });

    it("lists the config notices under the marker, and only the marker line starts with `router: engine=`", async () => {
      editOverride({ routing: { engine: "advise", margn: 0.5 } });
      const text = await runRouter("v2");
      expect(markerLines(text)).toEqual([formatRouterLine("advise")]);
      const lines = text.split("\n");
      const at = lines.indexOf(formatRouterLine("advise"));
      expect(lines[at + 1]).toBe("router: config notice: ignoring unknown routing key: routing.margn");
    });

    it("lists no notice lines for a clean config", async () => {
      editOverride({ routing: { engine: "advise" } });
      expect((await runRouter("v2")).split("\n").filter((l) => l.startsWith("router: config notice:"))).toEqual([]);
    });

    it("logs a config notice once per process through the plugin logger, across state writes and reloads (QA-1.1-23)", async () => {
      editOverride({ routing: { engine: "advise", margn: 0.5 } });
      const count = (): number =>
        warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).filter((m: string) => m.includes("routing.margn")).length;
      await runRouter("v2");
      expect(count()).toBe(1);
      writeState({ activePreset: "openai" });
      await runRouter("v2");
      await runRouter("v2");
      expect(count()).toBe(1);
      // ...while /router keeps listing it every time.
      expect(await runRouter("v2")).toContain("router: config notice: ignoring unknown routing key: routing.margn");
    });

    it("does not add the line to the other /router views", async () => {
      expect(markerLines(await runRouter("v2", "overrides"))).toHaveLength(0);
      expect(markerLines(await runRouter("v2", "enforce"))).toHaveLength(0);
    });

    it("shows the live engine after an edit of the global override, without a reload command", async () => {
      expect(markerLines(await runRouter("v2"))[0]).toContain("engine=static");

      editOverride({ routing: { engine: "advise" } });
      expect(markerLines(await runRouter("v2"))[0]).toContain("engine=advise");

      editOverride({ routing: { engine: "enforce", margin: 0.25 } });
      expect(markerLines(await runRouter("v2"))[0]).toContain("engine=enforce");

      unlinkSync(overridePath());
      expect(markerLines(await runRouter("v2"))[0]).toContain("engine=static");
    });

    const v1Notices = (): string[] =>
      warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).filter((m: string) => m.includes("routing.engine ignored"));

    it("logs the v1 notice exactly once at plugin init, before any /router (QA-1.1-8)", async () => {
      editOverride({ routing: { engine: "enforce" } });
      const ctx = {} as unknown as Parameters<typeof ModelRouterPlugin>[0];
      await ModelRouterPlugin(ctx);
      expect(v1Notices()).toEqual(["[model-router] routing.engine ignored on OpenCode v1"]);
      await runRouter(undefined);
      await runRouter(undefined);
      expect(v1Notices()).toHaveLength(1);
    });

    it("logs no notice at init on v2, for engine static on v1, or without a routing block", async () => {
      editOverride({ routing: { engine: "enforce" } });
      await ModelRouterPlugin({ routerHost: "v2" } as unknown as Parameters<typeof ModelRouterPlugin>[0]);
      expect(v1Notices()).toEqual([]);
      editOverride({ routing: { engine: "static" } });
      await ModelRouterPlugin({} as unknown as Parameters<typeof ModelRouterPlugin>[0]);
      unlinkSync(overridePath());
      invalidateConfigCache();
      await ModelRouterPlugin({} as unknown as Parameters<typeof ModelRouterPlugin>[0]);
      expect(v1Notices()).toEqual([]);
    });

    it("reports the applied (coerced) engine on v1 and logs the notice once", async () => {
      editOverride({ routing: { engine: "enforce" } });
      const first = markerLines(await runRouter(undefined));
      const second = markerLines(await runRouter(undefined));
      expect(first).toEqual([formatRouterLine("static")]);
      expect(second).toEqual([formatRouterLine("static")]);
      const notices = warnSpy.mock.calls.filter((c: unknown[]) => String(c[0]).includes("routing.engine ignored"));
      expect(notices).toHaveLength(1);
      expect(notices[0]![0]).toBe("[model-router] routing.engine ignored on OpenCode v1");
    });
  });
});

// ---------------------------------------------------------------------------
// build-info (1.1.6)
// ---------------------------------------------------------------------------

const SHA_A = "0123456789abcdef0123456789abcdef01234567";
const SHA_B = "fedcba9876543210fedcba9876543210fedcba98";
const SHA_C = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("build-info", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oc-mr-build-info-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(rel: string, content: string): string {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content, "utf-8");
    return p;
  }

  describe("readGitSha", () => {
    it('returns "unknown" without throwing when .git is absent', () => {
      expect(() => readGitSha(dir)).not.toThrow();
      expect(readGitSha(dir)).toBe("unknown");
    });

    it("reads HEAD → loose ref in a regular checkout", () => {
      write(".git/HEAD", "ref: refs/heads/main\n");
      write(".git/refs/heads/main", `${SHA_A}\n`);
      expect(readGitSha(dir)).toBe(SHA_A);
    });

    it("reads a ref whose name has several path segments", () => {
      write(".git/HEAD", "ref: refs/heads/car/p11\n");
      write(".git/refs/heads/car/p11", `${SHA_A}\n`);
      expect(readGitSha(dir)).toBe(SHA_A);
    });

    it("reads a detached HEAD (the sha itself) and lower-cases it", () => {
      write(".git/HEAD", `${SHA_A.toUpperCase()}\n`);
      expect(readGitSha(dir)).toBe(SHA_A);
    });

    it("falls back to packed-refs, skipping comments, peeled lines and other refs", () => {
      write(".git/HEAD", "ref: refs/heads/main\n");
      write(
        ".git/packed-refs",
        [
          "# pack-refs with: peeled fully-peeled sorted",
          `${SHA_B} refs/heads/main-old`,
          `${SHA_C} refs/tags/v1`,
          `^${SHA_B}`,
          `${SHA_A} refs/heads/main`,
          "",
        ].join("\n"),
      );
      expect(readGitSha(dir)).toBe(SHA_A);
    });

    it("prefers the loose ref over packed-refs", () => {
      write(".git/HEAD", "ref: refs/heads/main\n");
      write(".git/refs/heads/main", SHA_A);
      write(".git/packed-refs", `${SHA_B} refs/heads/main\n`);
      expect(readGitSha(dir)).toBe(SHA_A);
    });

    it("follows a .git FILE to a linked worktree's gitdir and its commondir (absolute gitdir)", () => {
      const gitdir = join(dir, "main", ".git", "worktrees", "wt");
      write("main/.git/worktrees/wt/HEAD", "ref: refs/heads/car/p11\n");
      write("main/.git/worktrees/wt/commondir", "../..\n");
      write("main/.git/refs/heads/car/p11", `${SHA_A}\n`);
      write("wt/.git", `gitdir: ${gitdir}\n`);
      expect(readGitSha(join(dir, "wt"))).toBe(SHA_A);
    });

    it("follows a .git FILE with a relative gitdir (submodule layout)", () => {
      write(".git/modules/sub/HEAD", "ref: refs/heads/main\n");
      write(".git/modules/sub/refs/heads/main", SHA_B);
      write("sub/.git", "gitdir: ../.git/modules/sub\n");
      expect(readGitSha(join(dir, "sub"))).toBe(SHA_B);
    });

    it("reads packed-refs of the common dir for a worktree whose branch is packed", () => {
      const gitdir = join(dir, "main", ".git", "worktrees", "wt");
      write("main/.git/worktrees/wt/HEAD", "ref: refs/heads/feature\n");
      write("main/.git/worktrees/wt/commondir", "../..");
      write("main/.git/packed-refs", `# pack-refs\n${SHA_C} refs/heads/feature\n`);
      write("wt/.git", `gitdir: ${gitdir}`);
      expect(readGitSha(join(dir, "wt"))).toBe(SHA_C);
    });

    it("reads a worktree's detached HEAD directly from its own gitdir", () => {
      const gitdir = join(dir, "main", ".git", "worktrees", "wt");
      write("main/.git/worktrees/wt/HEAD", `${SHA_B}\n`);
      write("wt/.git", `gitdir: ${gitdir}`);
      expect(readGitSha(join(dir, "wt"))).toBe(SHA_B);
    });

    it("accepts a 64-digit (sha256) object id", () => {
      const sha256 = SHA_A + SHA_B.slice(0, 24);
      write(".git/HEAD", `${sha256}\n`);
      expect(readGitSha(dir)).toBe(sha256);
    });

    it.each([
      ["an empty HEAD", () => write(".git/HEAD", "")],
      ["a garbage HEAD", () => write(".git/HEAD", "not a head\n")],
      ["a short sha", () => write(".git/HEAD", "0123abc\n")],
      ["a ref that exists nowhere", () => write(".git/HEAD", "ref: refs/heads/gone\n")],
      [
        "a loose ref that is not a sha and no packed-refs",
        () => {
          write(".git/HEAD", "ref: refs/heads/main\n");
          write(".git/refs/heads/main", "garbage\n");
        },
      ],
      [
        "a packed-refs line with a bad sha",
        () => {
          write(".git/HEAD", "ref: refs/heads/main\n");
          write(".git/packed-refs", "zzzz refs/heads/main\n");
        },
      ],
      ["a .git file without gitdir:", () => write(".git", "something else\n")],
      ["a .git file pointing at a missing directory", () => write(".git", `gitdir: ${join(dir, "nowhere")}\n`)],
      ["an empty .git directory", () => mkdirSync(join(dir, ".git"), { recursive: true })],
      [
        "a reftable repository (stub HEAD, refs in binary tables; not read)",
        () => {
          write(".git/HEAD", "ref: refs/heads/.invalid\n");
          write(".git/reftable/tables.list", "0x000000000001-0x000000000001-abcdef01.ref\n");
        },
      ],
    ])('returns "unknown" for %s, without throwing', (_label, setup) => {
      setup();
      expect(() => readGitSha(dir)).not.toThrow();
      expect(readGitSha(dir)).toBe("unknown");
    });

    it("never throws for a root that is not even a string", () => {
      const notAString = undefined as unknown as string;
      expect(() => readGitSha(notAString)).not.toThrow();
      expect(readGitSha(notAString)).toBe("unknown");
    });

    it.each([
      ["a path that does not exist", join(tmpdir(), "oc-mr-no-such-dir-xyz", "deeper")],
      ["an empty string", ""],
      ["a path containing NUL", "bad\0path"],
    ])('never throws for %s', (_label, root) => {
      expect(() => readGitSha(root)).not.toThrow();
      expect(typeof readGitSha(root)).toBe("string");
    });
  });

  describe("readPackageVersion / readBuildInfo", () => {
    it("reads the version of the package.json at the root", () => {
      write("package.json", JSON.stringify({ name: "x", version: "9.8.7" }));
      expect(readPackageVersion(dir)).toBe("9.8.7");
    });

    it.each([
      ["no package.json", undefined],
      ["malformed JSON", "{ nope"],
      ["JSON null", "null"],
      ["no version", JSON.stringify({ name: "x" })],
      ["a non-string version", JSON.stringify({ version: 2 })],
      ["an empty version", JSON.stringify({ version: "" })],
    ])('returns "unknown" for %s', (_label, content) => {
      if (content !== undefined) write("package.json", content);
      expect(readPackageVersion(dir)).toBe("unknown");
    });

    it("combines both, and is frozen", () => {
      write("package.json", JSON.stringify({ version: "1.2.3" }));
      write(".git/HEAD", `${SHA_A}\n`);
      const info = readBuildInfo(dir);
      expect(info).toEqual({ version: "1.2.3", sha: SHA_A });
      expect(Object.isFrozen(info)).toBe(true);
    });

    it("loadBuildInfo degrades to unknown when locating the checkout throws (QA-1.1-20)", () => {
      const info = loadBuildInfo(() => {
        throw new Error("import.meta.url is not a file: URL");
      });
      expect(info).toEqual({ version: "unknown", sha: "unknown" });
      expect(Object.isFrozen(info)).toBe(true);
    });

    it("loadBuildInfo reads the checkout it is pointed at", () => {
      write("package.json", JSON.stringify({ version: "4.5.6" }));
      write(".git/HEAD", `${SHA_A}\n`);
      expect(loadBuildInfo(() => dir)).toEqual({ version: "4.5.6", sha: SHA_A });
    });

    it("degrades each part independently", () => {
      expect(readBuildInfo(dir)).toEqual({ version: "unknown", sha: "unknown" });
    });
  });

  describe("buildInfo (this checkout)", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")) as { version: string };
    const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf-8" });
    const gitHead = git.status === 0 ? git.stdout.trim() : undefined;

    it("has the package version", () => {
      expect(buildInfo.version).toBe(pkg.version);
    });

    it("has a full sha or unknown", () => {
      expect(buildInfo.sha).toMatch(/^(?:[0-9a-f]{40}|unknown)$/);
    });

    it.skipIf(gitHead === undefined || !/^[0-9a-f]{40}$/.test(gitHead))(
      "matches `git rev-parse HEAD` (works from a linked worktree, where .git is a file)",
      () => {
        expect(buildInfo.sha).toBe(gitHead);
        expect(readGitSha(ROOT)).toBe(gitHead);
      },
    );
  });

  describe("formatRouterLine (the /router marker format, pinned)", () => {
    it("is `router: engine=<mode> build=<version>+<sha7>`", () => {
      expect(formatRouterLine("shadow", { version: "2.3.0", sha: SHA_A })).toBe(
        "router: engine=shadow build=2.3.0+0123456",
      );
      expect(formatRouterLine("static", { version: "2.2.0", sha: SHA_B })).toBe(
        "router: engine=static build=2.2.0+fedcba9",
      );
    });

    it("keeps `unknown` whole instead of cutting it", () => {
      expect(formatRouterLine("enforce", { version: "2.3.0", sha: "unknown" })).toBe(
        "router: engine=enforce build=2.3.0+unknown",
      );
      expect(formatRouterLine("static", { version: "unknown", sha: "unknown" })).toBe(
        "router: engine=static build=unknown+unknown",
      );
    });

    it("defaults to this process's build info", () => {
      expect(formatRouterLine("static")).toBe(
        `router: engine=static build=${buildInfo.version}+${buildInfo.sha === "unknown" ? "unknown" : buildInfo.sha.slice(0, 7)}`,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// The global home guard (test/setup/home-guard.ts; QA-1.1-17, amendment A14).
// ---------------------------------------------------------------------------

describe("home guard (test/setup/home-guard.ts)", () => {
  const setEnv = (name: "HOME" | "USERPROFILE", value: string | undefined): void => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };

  it("follows the HOME/USERPROFILE redirect of the test", () => {
    expect(homedir()).toBe(tmpHome);
    expect(overridePath().startsWith(tmpHome)).toBe(true);
  });

  it("follows a redirect of HOME alone, even where os.homedir() natively ignores HOME (Windows)", () => {
    setEnv("USERPROFILE", ORIGINAL_ENV.USERPROFILE);
    expect(homedir()).toBe(tmpHome);
  });

  it("follows a redirect of USERPROFILE alone", () => {
    setEnv("HOME", ORIGINAL_ENV.HOME);
    expect(homedir()).toBe(tmpHome);
  });

  it("gives a test that redirected nothing a private empty home, never the real one", () => {
    setEnv("HOME", ORIGINAL_ENV.HOME);
    setEnv("USERPROFILE", ORIGINAL_ENV.USERPROFILE);
    const isolated = homedir();
    expect(isolated).not.toBe(REAL_HOME);
    expect(isolated).not.toBe(tmpHome);
    expect(existsSync(isolated)).toBe(true);
    expect(readdirSync(isolated)).toEqual([]);
    expect(overridePath().startsWith(isolated)).toBe(true);
  });

  it("is the very homedir this file and the code under test see (one module instance)", () => {
    expect(homedir).toBe(guardedHomedir);
  });

  describe("the per-test check (QA-1.1-22)", () => {
    it("passes for the guarded homedir", () => {
      expect(() => assertHomeIsGuarded(guardedHomedir)).not.toThrow();
      expect(() => assertHomeIsGuarded(() => tmpHome)).not.toThrow();
    });

    it("fails a file whose own node:os mock lets homedir() resolve the real home", () => {
      // What a `vi.mock("node:os", …)` without `homedir: guardedHomedir` leaves behind.
      expect(() => assertHomeIsGuarded(() => REAL_HOME)).toThrow(
        /home-guard: os\.homedir\(\) resolves the real home directory .* must include `homedir: guardedHomedir`/,
      );
    });

    it.each([
      ["a trailing slash", () => `${REAL_HOME}/`],
      ["a doubled trailing separator", () => `${REAL_HOME}//`],
      ["a `..` segment", () => join(REAL_HOME, "..", basename(REAL_HOME))],
      ["a `.` segment", () => join(REAL_HOME, ".")],
    ])("is not fooled by %s", (_label, spelled) => {
      expect(() => assertHomeIsGuarded(spelled)).toThrow(/home-guard/);
    });

    it.skipIf(process.platform !== "win32")("is not fooled by a different case on Windows", () => {
      expect(() => assertHomeIsGuarded(() => REAL_HOME.toUpperCase())).toThrow(/home-guard/);
      expect(() => assertHomeIsGuarded(() => REAL_HOME.toLowerCase())).toThrow(/home-guard/);
    });

    it("lets any other directory through", () => {
      expect(() => assertHomeIsGuarded(() => tmpdir())).not.toThrow();
      expect(() => assertHomeIsGuarded(() => join(REAL_HOME, "sub"))).not.toThrow();
    });
  });

  describe("sameDir", () => {
    it("compares directories by what they are, not by how they are spelled", () => {
      expect(sameDir(tmpHome, `${tmpHome}/`)).toBe(true);
      expect(sameDir(tmpHome, join(tmpHome, "x", ".."))).toBe(true);
      expect(sameDir(tmpHome, tmpdir())).toBe(false);
    });

    it("falls back to a normalized comparison for a path that is not on disk", () => {
      const missing = join(tmpHome, "not", "there");
      expect(sameDir(missing, join(missing, "..", "there"))).toBe(true);
      expect(sameDir(missing, join(tmpHome, "not", "elsewhere"))).toBe(false);
    });
  });

  it("throws, before anything can be written, when a test resolves the real home", () => {
    // A trailing slash: a different string than the starting env, the same directory.
    setEnv("HOME", `${REAL_HOME}/`);
    setEnv("USERPROFILE", `${REAL_HOME}/`);
    expect(() => homedir()).toThrow(/home-guard: a test resolved the real home directory/);
    expect(() => overridePath()).toThrow(/home-guard/);
    expect(() => loadConfig()).toThrow(/home-guard/);
  });
});
// ---------------------------------------------------------------------------
// docs/CONFIG_REFERENCE.md must say what the code does (1.1.5): its defaults
// block and every example are parsed here, so a drift fails the build.
// ---------------------------------------------------------------------------

describe("docs/CONFIG_REFERENCE.md — routing section", () => {
  const docs = readFileSync(join(ROOT, "docs", "CONFIG_REFERENCE.md"), "utf-8");

  /** The JSONC fence that directly follows `<!-- <marker> -->`. */
  function blockAfter(marker: string): unknown {
    const at = docs.indexOf(`<!-- ${marker} -->`);
    expect(at, `marker ${marker}`).toBeGreaterThanOrEqual(0);
    const match = /```jsonc\n([\s\S]*?)\n```/.exec(docs.slice(at));
    expect(match, `fence after ${marker}`).not.toBeNull();
    return parseJsonc(match![1]!);
  }

  it("documents exactly the v2 defaults that resolveRouting applies", () => {
    const { applied: _applied, ...resolved } = resolveRouting(cfgOf(), "v2");
    expect(blockAfter("routing-defaults: v2")).toEqual(resolved);
  });

  it("lists every defaulted key in the keys table", () => {
    const paths = (value: unknown, prefix: string): string[] =>
      Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
        typeof v === "object" && v !== null && !Array.isArray(v) ? paths(v, `${prefix}${k}.`) : [`${prefix}${k}`],
      );
    const { roles: _roles, ...defaults } = ROUTING_DEFAULTS as Record<string, unknown>;
    const keys = [...paths(defaults, ""), "classifier.presets", "roles"];
    for (const key of keys) {
      expect(docs, key).toContain(`| \`${key}\` |`);
    }
  });

  it.each(["static", "shadow", "advise", "enforce"] as const)("has a valid, working example for engine %s", (mode) => {
    const example = blockAfter(`routing-example: ${mode}`);
    const cfg = validateConfig(rawConfig(example as Record<string, unknown>));
    expect(resolveRouting(cfg, "v2").engine).toBe(mode);
  });

  it("has a valid example for candidates, resolved as documented", () => {
    const example = blockAfter("routing-example: candidates");
    const cfg = validateConfig(deepMerge(rawConfig(), example) as Record<string, unknown>);
    expect(resolveCandidates("medium", cfg)).toEqual([
      { model: "anthropic/claude-sonnet-5-5", variant: "medium", costRatio: 5 },
      { model: "anthropic/claude-sonnet-5-5", variant: "high", costRatio: 8 },
      { model: "openai/gpt-6-luna", variant: "high", costRatio: 9 },
    ]);
  });

  it("documents the /router marker line, the v1 notice and the variantSteps / roles rules", () => {
    expect(docs).toContain("router: engine=<mode> build=<version>+<sha7>");
    expect(docs).toContain("[model-router] routing.engine ignored on OpenCode v1");
    expect(docs).toContain("`variantSteps`");
    expect(docs).toContain("**`roles: {}`** disables native candidates");
  });
});
