import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configPath, getConfigNotices, invalidateConfigCache, loadConfig, OVERRIDE_FILENAME } from "../../src/router/config";
import { effectiveTierModels, SMOKE_PRESET, smokeTierOverride } from "../smoke/helpers/tier-override";

// guard-hardblock.smoke.test.ts writes this overrides file when MODEL_ROUTER_SMOKE_MODEL is set, then asserts the
// subagent ran on that model. An override the loader drops keeps the bundled tiers, which only the weekly credentialed
// lane would report; this pins the file against the real loader on every `npm test`.
describe("smoke tier override (MODEL_ROUTER_SMOKE_MODEL)", () => {
  const model = "opencode-go/qwen3.7-plus";
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  let root: string;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    root = join(tmpdir(), `omr-smoke-override-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    // A private home: no global override or /preset state file can take part.
    mkdirSync(join(root, "home"), { recursive: true });
    process.env.HOME = join(root, "home");
    process.env.USERPROFILE = join(root, "home");
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    invalidateConfigCache();
  });

  afterEach(() => {
    warn.mockRestore();
    for (const key of ["HOME", "USERPROFILE"] as const) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    invalidateConfigCache();
  });

  /** A repository whose `.opencode/` holds `override`, as the smoke writes it at the repo root. */
  function project(override: unknown): string {
    const dir = join(root, "project");
    mkdirSync(join(dir, ".git"), { recursive: true });
    mkdirSync(join(dir, ".opencode"), { recursive: true });
    writeFileSync(join(dir, ".opencode", OVERRIDE_FILENAME), JSON.stringify(override, null, 2), "utf8");
    return dir;
  }

  it("loads as the active preset with every tier on the smoke model and no bundled variant or effort", () => {
    const cfg = loadConfig(project(smokeTierOverride(model)));
    expect(warn).not.toHaveBeenCalled();
    expect(cfg.activePreset).toBe(SMOKE_PRESET);
    for (const name of ["fast", "medium", "heavy"]) {
      const tier = cfg.presets[SMOKE_PRESET]?.[name];
      expect(tier?.model, name).toBe(model);
      expect(tier?.variant, name).toBeUndefined();
      expect(tier?.effort, name).toBeUndefined();
    }
  });

  // layer2-gate.smoke.test.ts runs the host in a throwaway git project with a private home and calls
  // effectiveTierModels first, so a non-effective override fails by name instead of after a live run.
  it("effectiveTierModels: a git project under a private home resolves every tier to the smoke model", () => {
    const dir = project(smokeTierOverride(model));
    const seen = effectiveTierModels(dir, join(root, "home"));
    expect(seen.warnings).toEqual([]);
    expect(seen.activePreset).toBe(SMOKE_PRESET);
    expect(seen.models).toEqual({ fast: model, medium: model, heavy: model });
  });

  it("effectiveTierModels: a /preset state file in the home outranks the override's activePreset and is reported", () => {
    const dir = project(smokeTierOverride(model));
    const stateDir = join(root, "home", ".config", "opencode");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "opencode-model-router.state.json"), JSON.stringify({ activePreset: "anthropic" }), "utf8");
    const seen = effectiveTierModels(dir, join(root, "home"));
    expect(seen.activePreset).toBe("anthropic");
    expect(seen.models.fast).not.toBe(model);
  });

  it("the former fixture (the bundled preset patched with variant \"\") loses only `variant` (#80): the bundled variant still rides along", () => {
    const bundled = JSON.parse(readFileSync(configPath(), "utf8")) as {
      activePreset: string;
      presets: Record<string, Record<string, { model: string; variant?: string }>>;
    };
    const tier = { model, variant: "" };
    const dir = project({ presets: { [bundled.activePreset]: { fast: tier, medium: tier, heavy: tier } } });
    const cfg = loadConfig(dir);
    for (const name of ["fast", "medium", "heavy"]) {
      const loaded = cfg.presets[cfg.activePreset]?.[name];
      expect(loaded?.model, name).toBe(model);
      // `""` is dropped, so the bundled Anthropic variant is not suppressed: why the smoke uses its own preset.
      expect(loaded?.variant, name).toBe(bundled.presets[bundled.activePreset]?.[name]?.variant);
    }
    expect(warn.mock.calls.flat().join("\n")).toMatch(/fast\.variant' must be a non-empty string/);
    expect(getConfigNotices(dir).map((n) => n.message).filter((m) => m.startsWith("ignoring "))).toEqual(
      ["fast", "medium", "heavy"].map((name) =>
        expect.stringMatching(new RegExp(`^ignoring presets\\.${bundled.activePreset}\\.${name}\\.variant from .*: .*must be a non-empty string`)),
      ),
    );
  });
});
