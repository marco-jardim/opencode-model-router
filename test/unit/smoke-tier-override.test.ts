import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configPath, invalidateConfigCache, loadConfig, OVERRIDE_FILENAME } from "../../src/router/config";
import { SMOKE_PRESET, smokeTierOverride } from "../smoke/helpers/tier-override";

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

  it("the former fixture (the bundled preset patched with variant \"\") is dropped whole: fast stays on the bundled model", () => {
    const bundled = JSON.parse(readFileSync(configPath(), "utf8")) as {
      activePreset: string;
      presets: Record<string, Record<string, { model: string }>>;
    };
    const tier = { model, variant: "" };
    const cfg = loadConfig(project({ presets: { [bundled.activePreset]: { fast: tier, medium: tier, heavy: tier } } }));
    expect(cfg.presets[cfg.activePreset]?.fast?.model).toBe(bundled.presets[bundled.activePreset]?.fast?.model);
    expect(cfg.presets[cfg.activePreset]?.fast?.model).not.toBe(model);
    expect(warn.mock.calls.flat().join("\n")).toMatch(/fast\.variant' must be a non-empty string/);
  });
});
