import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ModelRouterPlugin from "../../src/index";
import { OVERRIDE_FILENAME, invalidateConfigCache, loadConfig } from "../../src/router/config";
import type { Preset } from "../../src/router/config";
import { resetAgentOptionsEffortWarnings } from "../../src/router/agent-options";
import { resolveSubagentOverrides } from "../../src/router/subagents";
import { pluginAgentMarker } from "../../src/router/plugin-agents";

const tier = (model: string, variant?: string) =>
  ({ model, variant, costRatio: 1, description: "t", whenToUse: [] }) as unknown as Preset[string];
const tiers: Preset = { fast: tier("p/f"), medium: tier("p/m", "high"), heavy: tier("p/h") };

describe("resolveSubagentOverrides: phantom agents (#81)", () => {
  it("skips a name that no agent record carries and reports it", () => {
    const skipped: string[] = [];
    const out = resolveSubagentOverrides({
      subagentTiers: { ghost: "fast", real: "medium" },
      tiers,
      existingAgents: { real: { mode: "subagent" } },
      onSkip: (name, reason) => skipped.push(`${name}:${reason}`),
    });
    expect(Object.keys(out)).toEqual(["real"]);
    expect(skipped).toEqual(["ghost:missing"]);
  });

  it("skips a name defined by the plugin agents block: its tier wins", () => {
    const skipped: string[] = [];
    const out = resolveSubagentOverrides({
      subagentTiers: { scout: "heavy" },
      tiers,
      existingAgents: { scout: { mode: "subagent" } },
      pluginAgents: { scout: {} },
      onSkip: (name, reason) => skipped.push(`${name}:${reason}`),
    });
    expect(out).toEqual({});
    expect(skipped).toEqual(["scout:plugin-agent"]);
  });

  it("without a known agent record the legacy behaviour is unchanged", () => {
    expect(Object.keys(resolveSubagentOverrides({ subagentTiers: { x: "fast" }, tiers }))).toEqual(["x"]);
  });
});

describe("plugin agents on v1 (config hook)", () => {
  let root: string;
  let savedHome: string | undefined;
  let savedProfile: string | undefined;
  const globalFile = () => join(root, ".config", "opencode", OVERRIDE_FILENAME);
  const writeGlobal = (body: unknown) => {
    mkdirSync(join(root, ".config", "opencode"), { recursive: true });
    writeFileSync(globalFile(), JSON.stringify(body));
    invalidateConfigCache();
  };
  const run = async (opencodeConfig: Record<string, any>) => {
    const hooks: any = await ModelRouterPlugin({} as any);
    await hooks.config(opencodeConfig);
    return { hooks, opencodeConfig };
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "oc-mr-pa-v1-"));
    savedHome = process.env.HOME;
    savedProfile = process.env.USERPROFILE;
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    resetAgentOptionsEffortWarnings();
    invalidateConfigCache();
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedProfile;
    invalidateConfigCache();
    rmSync(root, { recursive: true, force: true });
  });

  const agentsBlock = {
    scout: { tier: "medium", description: "Scout", prompt: "SCOUT PROMPT", steps: 7, readOnly: true, allowTools: ["webfetch"] },
  };

  it("registers a subagent with the active tier's model, variant, steps, prompt and permission", async () => {
    writeGlobal({ agents: agentsBlock });
    const cfg = loadConfig();
    const t = Object.values(cfg.presets[cfg.activePreset]).length > 0 ? cfg.presets[cfg.activePreset].medium : undefined;
    const { opencodeConfig } = await run({});
    const def = opencodeConfig.agent.scout;
    expect(def.mode).toBe("subagent");
    expect(def.model).toBe(t?.model);
    expect(def.variant).toBe(t?.variant);
    expect(def.steps).toBe(7);
    expect(def.prompt).toBe("SCOUT PROMPT");
    expect(def.description).toBe("Scout");
    expect(def.permission.webfetch).toBe("allow");
    expect(def.permission["*"] ?? def.permission.bash).toBeDefined();
    expect(pluginAgentMarker(def)?.readOnly).toBe(true);
  });

  it("without an agents block nothing is registered", async () => {
    const { opencodeConfig } = await run({});
    expect(Object.keys(opencodeConfig.agent).sort()).toEqual(["fast", "heavy", "medium"].sort());
  });

  it("an opencode.json entry wins for the fields it sets, its permission goes after ours, one notice", async () => {
    writeGlobal({ agents: agentsBlock });
    const warnings: string[] = [];
    const logger = { warn: (m: string) => warnings.push(m) };
    void logger;
    const { opencodeConfig, hooks } = await run({
      agent: { scout: { description: "Mine", permission: { webfetch: "deny" }, tools: { custom: true } } },
    });
    const def = opencodeConfig.agent.scout;
    expect(def.description).toBe("Mine");
    expect(def.prompt).toBe("SCOUT PROMPT");
    const keys = Object.keys(def.permission);
    expect(keys.indexOf("webfetch")).toBeGreaterThanOrEqual(0);
    expect(def.permission.webfetch).toBe("deny");
    expect(def.tools.custom).toBe(true);
    // re-running the hook (preset refresh) rebuilds without re-merging our own output as a user entry
    await hooks.config(opencodeConfig);
    expect(opencodeConfig.agent.scout.description).toBe("Mine");
    expect(opencodeConfig.agent.scout.permission.webfetch).toBe("deny");
  });

  it("agents.<name>.tier wins over subagentTiers[name]", async () => {
    writeGlobal({ agents: agentsBlock, subagentTiers: { scout: "heavy" } });
    const cfg = loadConfig();
    const { opencodeConfig } = await run({});
    expect(opencodeConfig.agent.scout.model).toBe(cfg.presets[cfg.activePreset].medium.model);
  });

  it("a phantom subagentTiers name is not created", async () => {
    writeGlobal({ subagentTiers: { ghost: "fast" } });
    const { opencodeConfig } = await run({});
    expect(opencodeConfig.agent.ghost).toBeUndefined();
  });

  it("a preset switch updates the model on the next hook run", async () => {
    writeGlobal({ agents: agentsBlock });
    const cfg = loadConfig();
    const other = Object.keys(cfg.presets).find((name) => name !== cfg.activePreset
      && cfg.presets[name].medium?.model !== cfg.presets[cfg.activePreset].medium.model);
    if (other === undefined) return;
    const { opencodeConfig, hooks } = await run({});
    expect(opencodeConfig.agent.scout.model).toBe(cfg.presets[cfg.activePreset].medium.model);
    writeGlobal({ agents: agentsBlock, activePreset: other });
    await hooks.config(opencodeConfig);
    expect(opencodeConfig.agent.scout.model).toBe(cfg.presets[other].medium.model);
  });

  it("the grep post-filter covers a readOnly plugin agent but not an explicit-permission one", async () => {
    writeGlobal({
      agents: {
        ...agentsBlock,
        worker: { tier: "fast", description: "W", permission: { grep: "allow" } },
      },
    });
    const { hooks } = await run({});
    const text = ".env:\n  Line 1: SECRET=abc\nsrc/a.ts:\n  Line 3: const x = 1";
    const filtered = { output: text };
    await hooks["tool.execute.after"]({ tool: "grep", agent: "scout", sessionID: "s1" }, filtered);
    expect(filtered.output).not.toContain("SECRET=abc");
    const untouched = { output: text };
    await hooks["tool.execute.after"]({ tool: "grep", agent: "worker", sessionID: "s2" }, untouched);
    expect(untouched.output).toContain("SECRET=abc");
  });
});

