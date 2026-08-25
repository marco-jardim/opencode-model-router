/**
 * End-to-end prompt-style resolution through the plugin's `config` hook: the
 * prompt each tier agent is registered with must match the style its tier
 * resolves to (explicit `promptStyle`, or `auto` by model).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import ModelRouterPlugin from "../../src/index";
import {
  OVERRIDE_FILENAME,
  invalidateConfigCache,
  writeState,
} from "../../src/router/config";
import { GOAL_ORIENTED_TIER_PROMPTS } from "../../src/router/prompts";

type AgentConfig = { model?: string; prompt?: string };
type OpencodeConfig = { agent?: Record<string, AgentConfig> };

/** Marker only present in the goal-oriented defaults. */
const GOAL_MARKER = "Your goal is to";
/** Marker only present in the shipped prescriptive tierPrompts. */
const PRESCRIPTIVE_MARKER = "STOP CONDITIONS";

function writeGlobalOverride(home: string, data: unknown): void {
  const dir = join(home, ".config", "opencode");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, OVERRIDE_FILENAME), JSON.stringify(data), "utf-8");
}

async function withPluginHome(
  prefix: string,
  body: (home: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevEnforce = process.env.MODEL_ROUTER_ENFORCE;
  const prevVerifiedDelegate = process.env.MODEL_ROUTER_VERIFIED_DELEGATE;

  try {
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    delete process.env.MODEL_ROUTER_ENFORCE;
    process.env.MODEL_ROUTER_VERIFIED_DELEGATE = "1";
    invalidateConfigCache();
    await body(dir);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    if (prevEnforce === undefined) delete process.env.MODEL_ROUTER_ENFORCE;
    else process.env.MODEL_ROUTER_ENFORCE = prevEnforce;
    if (prevVerifiedDelegate === undefined) delete process.env.MODEL_ROUTER_VERIFIED_DELEGATE;
    else process.env.MODEL_ROUTER_VERIFIED_DELEGATE = prevVerifiedDelegate;

    invalidateConfigCache();
    await rm(dir, { recursive: true, force: true });
  }
}

async function registerAgents(dir: string): Promise<Record<string, AgentConfig>> {
  const hooks = (await Reflect.apply(ModelRouterPlugin, undefined, [
    makeCtx(dir),
  ])) as Awaited<ReturnType<typeof ModelRouterPlugin>>;
  const ocCfg: OpencodeConfig = {};
  expect(hooks.config).toBeDefined();
  await hooks.config?.(ocCfg);
  return ocCfg.agent ?? {};
}

test("shipped hybrid preset mixes styles by model under auto", async () => {
  await withPluginHome("model-router-prompt-style-hybrid-", async (dir) => {
    writeState({ activePreset: "hybrid" });
    const agent = await registerAgents(dir);

    // No shipped preset sets promptStyle, so every tier resolves through auto.
    expect(agent.fast?.model).toBe("anthropic/claude-haiku-4-5");
    expect(agent.medium?.model).toBe("openai/gpt-5.6-terra-fast");
    expect(agent.heavy?.model).toBe("anthropic/claude-opus-5");

    // Weak models keep the enumerated prompts.
    expect(agent.fast?.prompt).toContain(PRESCRIPTIVE_MARKER);
    expect(agent.fast?.prompt).not.toContain(GOAL_MARKER);
    expect(agent.medium?.prompt).toContain(PRESCRIPTIVE_MARKER);
    expect(agent.medium?.prompt).not.toContain(GOAL_MARKER);

    // opus-4-8 is a strong model: goal-oriented.
    expect(agent.heavy?.prompt).toContain(GOAL_MARKER);
    expect(agent.heavy?.prompt).not.toContain(PRESCRIPTIVE_MARKER);
    expect(agent.heavy?.prompt).toContain("SCOPE GROWTH:");
  });
});

test("fable-effort preset resolves every tier to goal-oriented under auto", async () => {
  await withPluginHome("model-router-prompt-style-fable-", async (dir) => {
    writeState({ activePreset: "fable-effort" });
    const agent = await registerAgents(dir);

    for (const name of ["fast", "medium", "heavy"] as const) {
      expect(agent[name]?.model).toBe("anthropic/claude-fable-5");
      expect(agent[name]?.prompt).toContain(GOAL_MARKER);
      expect(agent[name]?.prompt).not.toContain(PRESCRIPTIVE_MARKER);
      expect(agent[name]?.prompt).toContain(GOAL_ORIENTED_TIER_PROMPTS[name]);
    }
  });
});

test("explicit per-tier promptStyle beats the model-based auto rule", async () => {
  await withPluginHome("model-router-prompt-style-mixed-", async (dir) => {
    // fast:   weak model  + explicit goal-oriented -> goal-oriented
    // medium: strong model + explicit prescriptive -> prescriptive
    // heavy:  strong model + explicit auto         -> goal-oriented
    writeGlobalOverride(dir, {
      presets: {
        mixed: {
          fast: {
            model: "anthropic/claude-haiku-4-5",
            description: "weak model, forced goal-oriented",
            whenToUse: ["tests"],
            promptStyle: "goal-oriented",
          },
          medium: {
            model: "anthropic/claude-fable-5",
            description: "strong model, forced prescriptive",
            whenToUse: ["tests"],
            promptStyle: "prescriptive",
          },
          heavy: {
            model: "anthropic/claude-opus-4-8",
            description: "strong model, explicit auto",
            whenToUse: ["tests"],
            promptStyle: "auto",
          },
        },
      },
    });
    writeState({ activePreset: "mixed" });
    const agent = await registerAgents(dir);

    expect(agent.fast?.prompt).toContain(GOAL_MARKER);
    expect(agent.fast?.prompt).not.toContain(PRESCRIPTIVE_MARKER);

    expect(agent.medium?.prompt).toContain(PRESCRIPTIVE_MARKER);
    expect(agent.medium?.prompt).not.toContain(GOAL_MARKER);

    expect(agent.heavy?.prompt).toContain(GOAL_MARKER);
    expect(agent.heavy?.prompt).not.toContain(PRESCRIPTIVE_MARKER);
  });
});

test("tierPromptsGoalOriented overrides the built-in goal-oriented default", async () => {
  await withPluginHome("model-router-prompt-style-override-", async (dir) => {
    writeGlobalOverride(dir, {
      tierPromptsGoalOriented: { heavy: "CUSTOM GOAL HEAVY" },
      presets: {
        custom: {
          heavy: {
            model: "anthropic/claude-opus-4-8",
            description: "strong model",
            whenToUse: ["tests"],
          },
        },
      },
    });
    writeState({ activePreset: "custom" });
    const agent = await registerAgents(dir);

    expect(agent.heavy?.prompt).toContain("CUSTOM GOAL HEAVY");
    expect(agent.heavy?.prompt).not.toContain(GOAL_MARKER);
  });
});

test("an empty modelGenerations.strong list keeps every tier prescriptive", async () => {
  await withPluginHome("model-router-prompt-style-nostrong-", async (dir) => {
    writeGlobalOverride(dir, { modelGenerations: { strong: [] } });
    writeState({ activePreset: "fable-effort" });
    const agent = await registerAgents(dir);

    for (const name of ["fast", "medium", "heavy"] as const) {
      expect(agent[name]?.prompt).toContain(PRESCRIPTIVE_MARKER);
      expect(agent[name]?.prompt).not.toContain(GOAL_MARKER);
    }
  });
});

function makeCtx(dir: string) {
  return {
    directory: dir,
    worktree: dir,
    project: {},
    serverUrl: new URL("http://localhost"),
    $: () => undefined,
    client: {
      session: {
        create: async () => ({ data: { id: "s" } }),
      },
      prompt: async () => ({ data: { parts: [{ type: "text", text: "ok" }] } }),
    },
  };
}
