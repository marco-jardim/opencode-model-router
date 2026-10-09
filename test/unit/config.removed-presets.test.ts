import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildAgentOptions } from "../../src/router/agent-options";
import {
  getConfigNotices,
  invalidateConfigCache,
  loadConfig,
  overridePath,
  statePath,
  writeState,
} from "../../src/router/config";
import { FABLE_EFFORT_2_5_0 } from "../helpers/legacy-presets";

// 2.6.0 removed the bundled `hybrid-2` and `fable-effort` presets (owner decision). What a config that
// still names one of them does, per source: the state file written by `/preset`, an override's
// `activePreset`, and an override that defines the preset itself (the migration path).

const BUNDLED = JSON.parse(readFileSync(join(__dirname, "../../tiers.json"), "utf-8")) as {
  activePreset: string;
  presets: Record<string, Record<string, { model: string }>>;
};

describe("a config naming a preset 2.6.0 removed", () => {
  let tmpHome: string;
  let project: string;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    const root = join(tmpdir(), `oc-mr-removed-presets-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tmpHome = join(root, "home");
    project = join(root, "project");
    mkdirSync(tmpHome, { recursive: true });
    // A repo marker keeps the project-override walk inside the temp project.
    mkdirSync(join(project, ".git"), { recursive: true });
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    invalidateConfigCache();
  });

  afterEach(() => {
    warnSpy.mockRestore();
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    try {
      rmSync(dirname(tmpHome), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      // best-effort cleanup
    }
    invalidateConfigCache();
  });

  function writeOverride(data: unknown): void {
    const p = overridePath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(data), "utf-8");
    invalidateConfigCache();
  }

  it("the bundled tiers.json no longer defines hybrid-2 or fable-effort", () => {
    expect(Object.keys(BUNDLED.presets)).not.toContain("hybrid-2");
    expect(Object.keys(BUNDLED.presets)).not.toContain("fable-effort");
  });

  it.each(["fable-effort", "hybrid-2"])(
    "a state file whose /preset choice is %s loads on the configured activePreset and says so in one notice",
    (removed) => {
      writeState({ activePreset: removed });
      invalidateConfigCache();

      const cfg = loadConfig(project);

      expect(cfg.activePreset).toBe(BUNDLED.activePreset);
      const defined = Object.keys(BUNDLED.presets).join(", ");
      expect(getConfigNotices(project)).toEqual([
        {
          source: statePath(),
          message: `the preset '${removed}' chosen with /preset is not defined (defined: ${defined}); using '${BUNDLED.activePreset}'`,
        },
      ]);
      // A notice, not a source failure: nothing is dropped and nothing is warned.
      expect(warnSpy).not.toHaveBeenCalled();
    },
  );

  it("a state file naming a defined preset adds no notice", () => {
    writeState({ activePreset: "openai" });
    invalidateConfigCache();

    expect(loadConfig(project).activePreset).toBe("openai");
    expect(getConfigNotices(project)).toEqual([]);
  });

  it("an override whose activePreset names a removed preset is dropped as a whole layer (unchanged behaviour)", () => {
    // `tierCaps` stands for every other key the same file sets: it goes with the layer.
    writeOverride({ activePreset: "fable-effort", tierCaps: { fast: 2 } });

    const cfg = loadConfig(project);

    expect(cfg.activePreset).toBe(BUNDLED.activePreset);
    expect(cfg.presets).not.toHaveProperty("fable-effort");
    expect(cfg.tierCaps?.fast).not.toBe(2);
    const warnings = warnSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    const reason = `tiers.json: 'activePreset' is 'fable-effort', which is not a defined preset (defined: ${Object.keys(BUNDLED.presets).join(", ")})`;
    expect(warnings).toEqual([
      `[model-router] combined overrides are invalid (${reason}); dropping conflicting layer(s)`,
      `[model-router] ignoring ${overridePath()}: ${reason}`,
    ]);
  });

  it("an override that defines the 2.5.0 fable-effort block keeps it working: efforts low/high/xhigh", () => {
    writeOverride({ activePreset: "fable-effort", presets: { "fable-effort": FABLE_EFFORT_2_5_0 } });

    const cfg = loadConfig(project);

    expect(cfg.activePreset).toBe("fable-effort");
    const preset = cfg.presets["fable-effort"]!;
    expect(Object.fromEntries(Object.entries(preset).map(([name, tier]) => [name, tier.model]))).toEqual({
      fast: "anthropic/claude-fable-5-1",
      medium: "anthropic/claude-fable-5-1",
      heavy: "anthropic/claude-fable-5-1",
    });
    expect(buildAgentOptions(preset.fast!, "fast")).toEqual({ effort: "low" });
    expect(buildAgentOptions(preset.medium!, "medium")).toEqual({ effort: "high" });
    expect(buildAgentOptions(preset.heavy!, "heavy")).toEqual({ effort: "xhigh" });
    expect(getConfigNotices(project)).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("a /preset choice of fable-effort made under 2.5.0 resolves again once the override defines it", () => {
    writeState({ activePreset: "fable-effort" });
    writeOverride({ presets: { "fable-effort": FABLE_EFFORT_2_5_0 } });

    expect(loadConfig(project).activePreset).toBe("fable-effort");
    expect(getConfigNotices(project)).toEqual([]);
  });
});
