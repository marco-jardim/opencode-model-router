import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import {
  getConfigNotices,
  getConfigReloadError,
  invalidateConfigCache,
  loadConfig,
  localOverridePath,
  overridePath,
  statePath,
  OVERRIDE_FILENAME,
  type RouterConfig,
} from "../../src/router/config";

// ---------------------------------------------------------------------------
// adaptiveRouting is a global-only opt-in: a project-local override file must
// not be able to enable it or to widen the global managedTiers/local policy.
// Isolation mirrors adaptive-routing-config.test.ts (QA-1.1-1): the global
// setup mocks os.homedir() via HOME/USERPROFILE; the guard fails every test
// before it can write outside the temporary home. The project directory is a
// subdirectory of the temporary home so the project override stays inside it.
// ---------------------------------------------------------------------------

let tmpHome = "";
let projDir = "";
let restoreHomeEnv: () => void = () => {};

/** Throw unless `p` is a path strictly inside the temporary home. */
function assertInsideTmpHome(p: string): void {
  const rel = tmpHome === "" ? "" : relative(tmpHome, p);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `adaptive-routing-precedence.test: refusing to touch ${p}: it is not inside the temporary home "${tmpHome}" (QA-1.1-1)`,
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
  tmpHome = mkdtempSync(join(tmpdir(), "oc-mr-adaptive-prec-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  if (homedir() !== tmpHome) {
    throw new Error(`adaptive-routing-precedence.test: os.homedir() is "${homedir()}", not the temporary home "${tmpHome}" (QA-1.1-1)`);
  }
  projDir = mkdtempSync(join(tmpHome, "proj-"));
  assertInsideTmpHome(overridePath());
  assertInsideTmpHome(statePath());
  assertInsideTmpHome(localOverridePath(projDir));
  invalidateConfigCache();
});

afterEach(() => {
  restoreHomeEnv();
  if (tmpHome !== "") rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  tmpHome = "";
  projDir = "";
  invalidateConfigCache();
});

/** Write the global override inside the temporary home. */
function writeGlobalOverride(content: unknown): void {
  const p = overridePath();
  assertInsideTmpHome(p);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(content), "utf-8");
}

/** Write the project-local override inside the temporary project directory. */
function writeProjectOverride(content: unknown): void {
  const p = join(projDir, ".opencode", OVERRIDE_FILENAME);
  assertInsideTmpHome(p);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(content), "utf-8");
}

/**
 * Reads a top-level config key the static RouterConfig type may not declare
 * yet. Through `unknown` on purpose: the test asserts runtime parser behaviour.
 */
function keyOf(cfg: RouterConfig, key: string): unknown {
  return (cfg as unknown as Record<string, unknown>)[key];
}

const adaptiveNotices = (): string[] =>
  getConfigNotices(projDir).map((n) => n.message).filter((m) => m.includes("adaptiveRouting"));

describe("adaptiveRouting provenance - project layer cannot opt in or widen", () => {
  it("does not enable adaptiveRouting from a project layer alone", () => {
    writeProjectOverride({
      adaptiveRouting: {
        managedTiers: { workstation: ["fast", "medium", "heavy"] },
        local: true,
      },
    });
    const cfg = loadConfig(projDir);
    expect(keyOf(cfg, "adaptiveRouting")).toBeUndefined();
    expect(adaptiveNotices().length).toBeGreaterThan(0);
    expect(getConfigReloadError()).toBeNull();
  });

  it("keeps the global policy when a project layer attempts to widen it", () => {
    const globalBlock = {
      managedTiers: { workstation: ["fast", "medium"] },
      local: false,
    };
    writeGlobalOverride({ adaptiveRouting: globalBlock });
    writeProjectOverride({
      adaptiveRouting: {
        managedTiers: { workstation: ["fast", "medium", "heavy"] },
        local: true,
      },
    });
    const cfg = loadConfig(projDir);
    expect(keyOf(cfg, "adaptiveRouting")).toEqual(globalBlock);
    expect(adaptiveNotices().length).toBeGreaterThan(0);
    expect(getConfigReloadError()).toBeNull();
  });

  it("still applies the rest of a project layer that carried adaptiveRouting", () => {
    writeProjectOverride({
      adaptiveRouting: {
        managedTiers: { workstation: ["fast", "medium", "heavy"] },
        local: true,
      },
      dispatchHeader: false,
    });
    const cfg = loadConfig(projDir);
    expect(keyOf(cfg, "adaptiveRouting")).toBeUndefined();
    expect(cfg.dispatchHeader).toBe(false);
    expect(adaptiveNotices().length).toBeGreaterThan(0);
    expect(getConfigReloadError()).toBeNull();
  });

  it("keeps an own '__proto__' preset entry as data instead of setting the prototype", () => {
    // JSON.parse makes '__proto__' an own data key; a hand-written object
    // literal would silently set the prototype instead.
    const raw = JSON.parse(
      '{"adaptiveRouting":{"managedTiers":{"__proto__":["fast"],"workstation":["medium"]},"local":true}}',
    );
    writeGlobalOverride(raw);
    const cfg = loadConfig(projDir);
    const adaptive = keyOf(cfg, "adaptiveRouting") as
      | { managedTiers: Record<string, unknown>; local: boolean }
      | undefined;
    if (adaptive === undefined) {
      throw new Error("expected adaptiveRouting to be accepted");
    }
    expect(Object.getPrototypeOf(adaptive.managedTiers)).toBe(Object.prototype);
    expect(Object.hasOwn(adaptive.managedTiers, "__proto__")).toBe(true);
    expect(adaptive.managedTiers["__proto__"]).toEqual(["fast"]);
    expect(adaptive.managedTiers.workstation).toEqual(["medium"]);
    expect(adaptive.local).toBe(true);
    expect(getConfigReloadError()).toBeNull();
  });
});
