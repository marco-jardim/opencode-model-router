import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { opencodeConfig, hooks } = await run({
        agent: { scout: { description: "Mine", permission: { webfetch: "deny" }, tools: { custom: true } } },
      });
      const def = opencodeConfig.agent.scout;
      expect(def.description).toBe("Mine");
      expect(def.prompt).toBe("SCOUT PROMPT");
      expect(def.permission.webfetch).toBe("deny");
      expect(def.tools.custom).toBe(true);
      // re-running the hook (preset refresh) rebuilds without re-merging our own output as a user entry
      await hooks.config(opencodeConfig);
      expect(opencodeConfig.agent.scout.description).toBe("Mine");
      expect(opencodeConfig.agent.scout.permission.webfetch).toBe("deny");
      const notices = warn.mock.calls.map((args) => String(args[0]))
        .filter((text) => text.includes("agent scout is defined both in the router `agents` block and in opencode.json; opencode.json wins for the fields it sets"));
      expect(notices).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
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

  it("subagentTiers maps a host built-in agent (explore) absent from opencodeConfig.agent (QA-81-4)", async () => {
    writeGlobal({ subagentTiers: { explore: "fast", ghost: "fast" } });
    const cfg = loadConfig();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { opencodeConfig } = await run({});
    expect(opencodeConfig.agent.explore.model).toBe(cfg.presets[cfg.activePreset].fast.model);
    expect(opencodeConfig.agent.ghost).toBeUndefined();
    expect(warn.mock.calls.flat().join("\n")).not.toContain("'explore' is not defined");
    warn.mockRestore();
  });
  it.each([["same config object", (c: any) => c], ["cloned config (symbol marker lost)", (c: any) => JSON.parse(JSON.stringify(c))]])(
    "re-run drops a plugin agent removed from the router config (%s) (QA-81-8)", async (_label, rebuild) => {
      writeGlobal({ agents: agentsBlock });
      const first = await run({});
      expect(first.opencodeConfig.agent.scout).toBeDefined();
      writeGlobal({ agents: {} });
      invalidateConfigCache();
      const second = rebuild(first.opencodeConfig);
      await first.hooks.config(second);
      expect(second.agent.scout).toBeUndefined();
    },
  );
  it("a preset switch updates the model and variant on the next hook run", async () => {
    const presetTiers = (prefix: string, variant?: string) => Object.fromEntries(["fast", "medium", "heavy"].map((name) => [name, {
      model: `${prefix}/${name}`, costRatio: 1, description: name, whenToUse: ["anything"],
      ...(name === "medium" && variant ? { variant } : {}),
    }]));
    const block = { alpha: presetTiers("alpha"), beta: presetTiers("beta", "deep") };
    writeGlobal({ presets: block, activePreset: "alpha", agents: agentsBlock });
    const { opencodeConfig, hooks } = await run({});
    expect(opencodeConfig.agent.scout.model).toBe("alpha/medium");
    expect(opencodeConfig.agent.scout.variant).toBeUndefined();
    writeGlobal({ presets: block, activePreset: "beta", agents: agentsBlock });
    await hooks.config(opencodeConfig);
    expect(opencodeConfig.agent.scout.model).toBe("beta/medium");
    expect(opencodeConfig.agent.scout.variant).toBe("deep");
  });
  it("the grep post-filter covers every plugin agent with the real v1 hook shapes (QA-81-2, QA-81-3)", async () => {
    writeGlobal({
      agents: {
        ...agentsBlock,
        worker: { tier: "fast", description: "W", permission: { grep: "allow" } },
      },
    });
    const { hooks } = await run({});
    const text = "Found 2 matches\n/repo/.env:\n  Line 1: SECRET=abc\n/repo/src/a.ts:\n  Line 3: PUBLIC";
    // v1: `chat.message` names the agent; `tool.execute.after` carries no agent field.
    const grepAs = async (agent: string, sessionID: string): Promise<string> => {
      await hooks["chat.message"]({ sessionID, agent }, {
        message: { id: `user-${sessionID}`, sessionID, role: "user", time: { created: Date.now() }, agent, model: { providerID: "test", modelID: "test" } },
        parts: [],
      });
      const output = { title: "grep", metadata: {}, output: text };
      await hooks["tool.execute.after"]({ tool: "grep", sessionID, callID: `grep-${sessionID}`, args: {} }, output);
      return output.output;
    };
    for (const [agent, sessionID] of [["scout", "s1"], ["worker", "s2"]] as const) {
      const out = await grepAs(agent, sessionID);
      expect(out).not.toContain("SECRET=abc");
      expect(out).toContain("PUBLIC");
    }
    expect(await grepAs("medium", "s3")).toContain("SECRET=abc");
  });
});

