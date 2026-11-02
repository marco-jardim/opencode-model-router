import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import {
  getConfigNotices,
  getConfigReloadError,
  invalidateConfigCache,
  loadConfig,
  overridePath,
  statePath,
  type RouterConfig,
} from "../../src/router/config";

// ---------------------------------------------------------------------------
// adaptiveRouting is an opt-in top-level config block. An absent block keeps
// today's behaviour, byte for byte. An omitted `local` flag defaults to false
// (fail-closed for local execution). A malformed block is dropped with a config
// notice, never taking the rest of the config down with it. The module under
// test is the real loadConfig/validateConfig parser.
//
// Isolation mirrors config.routing.test.ts (QA-1.1-1): the global setup mocks
// os.homedir(); the env redirect below covers pools where it does not, and the
// guard fails every test before it can write outside the temporary home.
// ---------------------------------------------------------------------------

let tmpHome = "";
let restoreHomeEnv: () => void = () => {};

/** Throw unless `p` is a path strictly inside the temporary home. */
function assertInsideTmpHome(p: string): void {
  const rel = tmpHome === "" ? "" : relative(tmpHome, p);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `adaptive-routing-config.test: refusing to touch ${p}: it is not inside the temporary home "${tmpHome}" (QA-1.1-1)`,
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
  tmpHome = mkdtempSync(join(tmpdir(), "oc-mr-adaptive-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  if (homedir() !== tmpHome) {
    throw new Error(`adaptive-routing-config.test: os.homedir() is "${homedir()}", not the temporary home "${tmpHome}" (QA-1.1-1)`);
  }
  assertInsideTmpHome(overridePath());
  assertInsideTmpHome(statePath());
  invalidateConfigCache();
});

afterEach(() => {
  restoreHomeEnv();
  if (tmpHome !== "") rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  tmpHome = "";
  invalidateConfigCache();
});

/** A minimal valid config; `extra` overrides or adds top-level keys. */
function rawConfig(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    activePreset: "anthropic",
    presets: {
      anthropic: {
        fast: { model: "anthropic/claude-sonnet-5-5" },
        medium: { model: "anthropic/claude-sonnet-5-5", variant: "medium" },
        heavy: { model: "anthropic/claude-opus-5-5", variant: "xhigh" },
      },
    },
    ...extra,
  };
}

/** The documented opt-in shape. */
const AGREED_BLOCK = {
  managedTiers: { workstation: ["fast", "medium", "heavy"] },
  local: true,
};

/**
 * Reads a top-level config key the static RouterConfig type does not declare
 * yet. Through `unknown` on purpose: the test asserts runtime parser behaviour,
 * and the cast hides nothing (there is no declared property to bypass).
 */
function keyOf(cfg: RouterConfig, key: string): unknown {
  return (cfg as unknown as Record<string, unknown>)[key];
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

let tick = 0;
/** Write the global override WITHOUT invalidating the cache, bumping its mtime like a real edit. */
function editOverride(content: unknown): void {
  const p = overridePath();
  assertInsideTmpHome(p);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(content), "utf-8");
  const later = new Date(Date.now() + 60_000 * ++tick);
  utimesSync(p, later, later);
}

const adaptiveNotices = (): string[] =>
  getConfigNotices().map((n) => n.message).filter((m) => m.includes("adaptiveRouting"));

describe("adaptiveRouting config — opt-in acceptance", () => {
  it("is absent by default: no key, no notices, today's config loads unchanged", () => {
    editOverride(rawConfig());
    const cfg = loadConfig();
    expect(keyOf(cfg, "adaptiveRouting")).toBeUndefined();
    expect(adaptiveNotices()).toEqual([]);
    expect(getConfigReloadError()).toBeNull();
    expect(cfg.presets.anthropic?.fast?.model).toBe("anthropic/claude-sonnet-5-5");
  });

  it("accepts the documented opt-in block together with experimental.verifiedDelegateTool", () => {
    editOverride(
      rawConfig({
        experimental: { verifiedDelegateTool: true },
        adaptiveRouting: AGREED_BLOCK,
      }),
    );
    const cfg = loadConfig();
    expect(cfg.experimental?.verifiedDelegateTool).toBe(true);
    expect(keyOf(cfg, "adaptiveRouting")).toEqual(AGREED_BLOCK);
    expect(adaptiveNotices()).toEqual([]);
    expect(getConfigReloadError()).toBeNull();
  });

  it("defaults an omitted local flag to false: local execution stays fail-closed", () => {
    editOverride(
      rawConfig({
        adaptiveRouting: { managedTiers: { workstation: ["fast", "medium", "heavy"] } },
      }),
    );
    expect(keyOf(loadConfig(), "adaptiveRouting")).toEqual({
      managedTiers: { workstation: ["fast", "medium", "heavy"] },
      local: false,
    });
    expect(adaptiveNotices()).toEqual([]);
  });

  it.each([
    ["workstation as a plain string", { managedTiers: { workstation: "fast" } }],
    ["an unknown tier name", { managedTiers: { workstation: ["fast", "ultra"] } }],
  ])("drops a malformed block (%s) with a notice and keeps the rest of the config", (_name, adaptiveRouting) => {
    editOverride(rawConfig({ adaptiveRouting }));
    const cfg = loadConfig();
    expect(keyOf(cfg, "adaptiveRouting")).toBeUndefined();
    expect(adaptiveNotices().length).toBeGreaterThan(0);
    expect(getConfigReloadError()).toBeNull();
    expect(cfg.presets.anthropic?.fast?.model).toBe("anthropic/claude-sonnet-5-5");
  });
});
