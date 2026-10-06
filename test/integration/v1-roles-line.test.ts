/**
 * Amendment A28 (D1): the v1 text-only `R:` line for an explicit `routing.roles`, and the guarantee that without it the v1 system prompt is
 * byte-identical to what `assembleSystemPrompt` builds (§1.2).
 *
 * Drives the real plugin factory as a v1 host (no `routerHost`) with a fake client. HOME and the temp directory are redirected; the
 * override file lives in the redirected home.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ModelRouterPlugin from "../../src/index";
import type { RouterPluginInput } from "../../src/compat/child-session";
import { invalidateConfigCache, loadConfig, overridePath } from "../../src/router/config";
import { assembleSystemPrompt, buildTaskTaxonomy } from "../../src/router/protocol";
import { resolveEnforcementMode } from "../../src/router/enforcement";
import { applyV1Roles, hasExplicitV1Roles, v1AgentInfos } from "../../src/routing/commands/v1-roles";

type Hooks = {
  "experimental.chat.system.transform"(input: unknown, output: { system: string[] }): Promise<void>;
  dispose(): Promise<void>;
};

const AGENTS = [
  { name: "build", mode: "primary", builtIn: true },
  { name: "plan", mode: "primary", builtIn: true },
  { name: "general", mode: "subagent", builtIn: true },
  { name: "explore", mode: "subagent", builtIn: true, model: { providerID: "anthropic", modelID: "claude-haiku-4-5" } },
  { name: "reviewer", mode: "all", builtIn: false },
  { name: "ghost", mode: "subagent", builtIn: false, hidden: true },
  { name: "fast", mode: "subagent", builtIn: false },
  { name: "medium", mode: "subagent", builtIn: false },
  { name: "heavy", mode: "subagent", builtIn: false },
];

describe("v1: the text-only roles line (A28, D1)", () => {
  let home: string;
  let savedHome: string | undefined;
  let savedProfile: string | undefined;
  const instances: Hooks[] = [];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "v1-roles-"));
    savedHome = process.env.HOME;
    savedProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.MODEL_ROUTER_ENFORCE;
    invalidateConfigCache();
  });

  afterEach(async () => {
    for (const hooks of instances.splice(0)) await hooks.dispose();
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedProfile;
    invalidateConfigCache();
    rmSync(home, { recursive: true, force: true });
  });

  async function plugin(routing: Record<string, unknown> | null, agents: () => Promise<unknown> = async () => ({ data: AGENTS }), host: "v1" | "v2" = "v1") {
    mkdirSync(dirname(overridePath()), { recursive: true });
    writeFileSync(overridePath(), JSON.stringify({ activePreset: "anthropic", ...(routing === null ? {} : { routing }) }));
    invalidateConfigCache();
    const agentsCall = vi.fn(agents);
    const logs: string[] = [];
    const ctx = {
      directory: home,
      worktree: home,
      client: {
        app: { agents: agentsCall, log: async (request: { body: { message: string } }) => { logs.push(request.body.message); return {}; } },
        session: { get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id } }) },
      },
      ...(host === "v2" ? { routerHost: "v2" as const } : {}),
    };
    const hooks = (await ModelRouterPlugin(ctx as unknown as RouterPluginInput)) as unknown as Hooks;
    instances.push(hooks);
    return { hooks, agentsCall, logs };
  }

  const turn = async (hooks: Hooks, sessionID = "root-1"): Promise<string[]> => {
    const output = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]({ sessionID, model: { providerID: "anthropic", modelID: "claude-sonnet-5-5" } }, output);
    return output.system;
  };

  /** What the v1 plugin built before this phase: the assembled protocol for the config on disk, nothing swapped in. */
  const baseline = (): string => {
    invalidateConfigCache();
    const cfg = loadConfig(home);
    return assembleSystemPrompt(cfg, "anthropic/claude-sonnet-5-5", resolveEnforcementMode({ config: cfg, env: process.env }).mode !== "off");
  };
  const rLine = (prompt: string): string => prompt.split("\n").find((line) => line.startsWith("R:")) ?? "";
  const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

  it("with routing.roles set explicitly, the R: line lists the available agents per class (snapshot), and nothing else changes", async () => {
    const { hooks } = await plugin({ roles: { search: ["explore"], implement: ["general", "reviewer"], review: ["reviewer"], debug: ["ghost", "build", "missing", "fast"], design: [] } });
    const [prompt] = await turn(hooks);
    const before = baseline();
    expect(prompt).not.toBe(before);
    expect(rLine(prompt)).toMatchInlineSnapshot(`"R: @fast→search/grep/read/git-info/ls/lookup-docs/types/count/exists-check/rename @medium→impl-feature/refactor/write-tests/bugfix(≤2)/edit-logic/code-review/build-fix/create-file/db-migrate/api-endpoint/config-update @heavy→arch-design/debug(≥3fail)/sec-audit/perf-opt/migrate-strategy/multi-system-integration/tradeoff-analysis/rca | by class: search→@explore implement→@general/@reviewer review→@reviewer"`);
    // only the R: line moved: put the shipped line back and the prompt is the baseline again
    expect(prompt.replace(rLine(prompt), () => rLine(before))).toBe(before);
    // prose only: the engine's route-line paragraph (advise/enforce) is not added on v1
    expect(prompt).not.toContain("Routing line (optional)");
  });

  it("extends a taxonomy line that already exists: `<base> | by class: …`", async () => {
    const { hooks } = await plugin({ roles: { search: ["explore"] } });
    const [prompt] = await turn(hooks);
    const base = buildTaskTaxonomy(loadConfig(home));
    expect(base).not.toBe(""); // the shipped taskPatterns give a base line
    expect(rLine(prompt)).toBe(`${base} | by class: search→@explore`);
  });

  it("without routing.roles the system prompt is the baseline, byte for byte (SHA-256 pinned against the baseline), whatever else routing says", async () => {
    for (const routing of [null, {}, { engine: "enforce" }, { engine: "advise", profile: "safe", margin: 0.5 }, { roles: {} }, { advisor: { enabled: false } }, { classifier: { backend: "rules" } }]) {
      invalidateConfigCache();
      const { hooks, agentsCall } = await plugin(routing);
      const [prompt] = await turn(hooks);
      expect(sha(prompt!), `routing=${JSON.stringify(routing)}`).toBe(sha(baseline()));
      expect(prompt).toBe(baseline());
      expect(agentsCall).not.toHaveBeenCalled(); // the agent list is not even fetched
    }
  });

  it("a configured class whose agents are all unusable leaves the line as shipped", async () => {
    const { hooks } = await plugin({ roles: { search: ["build", "missing", "ghost", "fast"], debug: ["title", "compaction"] } });
    const [prompt] = await turn(hooks);
    expect(prompt).toBe(baseline());
  });

  it("an unavailable agent list is logged and the prompt stays the baseline; the list is cached between turns", async () => {
    const failing = await plugin({ roles: { search: ["explore"] } }, async () => { throw new Error("agents endpoint down"); });
    const [prompt] = await turn(failing.hooks);
    expect(prompt).toBe(baseline());
    expect(failing.logs.some((m) => m.includes("agent list is unavailable"))).toBe(true);
    const working = await plugin({ roles: { search: ["explore"] } });
    await turn(working.hooks, "a");
    await turn(working.hooks, "b");
    expect(working.agentsCall).toHaveBeenCalledTimes(1);
  });

  it("a malformed agent list (no data array) leaves the baseline", async () => {
    const { hooks } = await plugin({ roles: { search: ["explore"] } }, async () => ({ data: "nope" }));
    expect((await turn(hooks))[0]).toBe(baseline());
  });

  it("a v2 host never takes this path: the legacy hook builds the same prompt, and the agent list is not read", async () => {
    const { hooks, agentsCall } = await plugin({ roles: { search: ["explore"] } }, async () => ({ data: AGENTS }), "v2");
    expect((await turn(hooks))[0]).toBe(baseline());
    expect(agentsCall).not.toHaveBeenCalled();
  });

  it("the helpers: explicit roles only, `all` agents are dispatchable, a missing list is the baseline", () => {
    mkdirSync(dirname(overridePath()), { recursive: true });
    writeFileSync(overridePath(), JSON.stringify({ activePreset: "anthropic", routing: { roles: { search: ["explore"] } } }));
    invalidateConfigCache();
    const withRoles = loadConfig(home);
    expect(hasExplicitV1Roles(withRoles)).toBe(true);
    const prompt = assembleSystemPrompt(withRoles, undefined, false);
    expect(applyV1Roles(prompt, withRoles, null)).toBe(prompt);
    expect(applyV1Roles(prompt, withRoles, v1AgentInfos(AGENTS))).toContain("search→@explore");
    expect(v1AgentInfos([{ name: "x", mode: "all" }, { name: "" }, 3, { name: "y", mode: "primary", model: { providerID: "p", modelID: "m" } }])).toEqual([
      { id: "x", model: null, mode: "subagent", hidden: false, permitted: true, grants: [] },
      { id: "y", model: "p/m", mode: "primary", hidden: false, permitted: true, grants: [] },
    ]);
    writeFileSync(overridePath(), JSON.stringify({ activePreset: "anthropic" }));
    invalidateConfigCache();
    const plain = loadConfig(home);
    expect(hasExplicitV1Roles(plain)).toBe(false);
    const plainPrompt = assembleSystemPrompt(plain, undefined, false);
    expect(applyV1Roles(plainPrompt, plain, v1AgentInfos(AGENTS))).toBe(plainPrompt);
  });
});
