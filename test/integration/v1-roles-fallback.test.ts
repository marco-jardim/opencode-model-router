/**
 * QA-2.4-13: whatever goes wrong while the v1 roles line is built, the orchestrator still gets the baseline protocol, and the error is logged.
 * `applyV1Roles` is replaced by one that throws, so only the hook's own guard is under test.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ModelRouterPlugin from "../../src/index";
import type { RouterPluginInput } from "../../src/compat/child-session";
import { invalidateConfigCache, loadConfig, overridePath } from "../../src/router/config";
import { assembleSystemPrompt } from "../../src/router/protocol";
import { resolveEnforcementMode } from "../../src/router/enforcement";

vi.mock("../../src/routing/commands/v1-roles", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/routing/commands/v1-roles")>();
  return {
    ...original,
    applyV1Roles: () => {
      throw new Error("roles line exploded");
    },
  };
});

describe("v1 roles line: a failure leaves the baseline protocol (QA-2.4-13)", () => {
  let home: string;
  let savedHome: string | undefined;
  let savedProfile: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "v1-roles-fallback-"));
    savedHome = process.env.HOME;
    savedProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.MODEL_ROUTER_ENFORCE;
    invalidateConfigCache();
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedProfile;
    invalidateConfigCache();
    rmSync(home, { recursive: true, force: true });
  });

  it("a throwing applyV1Roles is logged and the system prompt is exactly the baseline", async () => {
    mkdirSync(dirname(overridePath()), { recursive: true });
    writeFileSync(overridePath(), JSON.stringify({ activePreset: "anthropic", routing: { roles: { search: ["explore"] } } }));
    invalidateConfigCache();
    const logs: string[] = [];
    const ctx = {
      directory: home,
      worktree: home,
      client: {
        app: { agents: async () => ({ data: [{ name: "explore", mode: "subagent", builtIn: true }] }), log: async (request: { body: { message: string } }) => { logs.push(request.body.message); return {}; } },
        session: { get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id } }) },
      },
    };
    const hooks = (await ModelRouterPlugin(ctx as unknown as RouterPluginInput)) as unknown as {
      "experimental.chat.system.transform"(input: unknown, output: { system: string[] }): Promise<void>;
      dispose(): Promise<void>;
    };
    try {
      const output = { system: [] as string[] };
      await hooks["experimental.chat.system.transform"]({ sessionID: "root-1", model: { providerID: "anthropic", modelID: "claude-sonnet-5-5" } }, output);
      invalidateConfigCache();
      const cfg = loadConfig(home);
      expect(output.system).toEqual([assembleSystemPrompt(cfg, "anthropic/claude-sonnet-5-5", resolveEnforcementMode({ config: cfg, env: process.env }).mode !== "off")]);
      expect(logs.some((m) => m.includes("the R: line could not be extended"))).toBe(true);
    } finally {
      await hooks.dispose();
    }
  });
});
