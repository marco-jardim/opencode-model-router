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
  /** Turn until the background refresh has landed and the prompt carries the roles line (or fail after 3 s). */
  const withRoles = async (hooks: Hooks, sessionID = "root-1"): Promise<string> => {
    const end = Date.now() + 3_000;
    let prompt = (await turn(hooks, sessionID))[0]!;
    while (!prompt.includes("by class:") && Date.now() < end) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      prompt = (await turn(hooks, sessionID))[0]!;
    }
    return prompt;
  };
  async function until(condition: () => boolean, ms = 3_000): Promise<void> {
    const end = Date.now() + ms;
    while (!condition() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(condition()).toBe(true);
  }
  const rLine = (prompt: string): string => prompt.split("\n").find((line) => line.startsWith("R:")) ?? "";
  const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

  it("QA-G-A3: adding a live engine by hot reload logs v1 coercion through the plugin, never console.warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { hooks, logs } = await plugin(null);
      await turn(hooks);
      writeFileSync(overridePath(), JSON.stringify({ activePreset: "anthropic", routing: { engine: "enforce", roles: { search: ["explore"] } } }));
      invalidateConfigCache();
      await turn(hooks);
      await until(() => logs.some((message) => message.includes("routing.engine ignored on OpenCode v1")));
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("with routing.roles set explicitly, the R: line lists the available agents per class (snapshot), and nothing else changes", async () => {
    const { hooks } = await plugin({ roles: { search: ["explore"], implement: ["general", "reviewer"], review: ["reviewer"], debug: ["ghost", "build", "missing", "fast"], design: [] } });
    const prompt = await withRoles(hooks);
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
    const prompt = await withRoles(hooks);
    const base = buildTaskTaxonomy(loadConfig(home));
    expect(base).not.toBe(""); // the shipped taskPatterns give a base line
    expect(rLine(prompt)).toBe(`${base} | by class: search→@explore`);
  });

  /**
   * What the v1 plugin put into `output.system` at 1fc94a3 (the commit this phase started from) for the `anthropic` preset, an orchestrator
   * of `anthropic/claude-sonnet-5-5`, advisory enforcement and a root session: ONE part, 6 357 characters. Computed by running this very
   * harness against a `git archive` of 1fc94a3, never against the current code (QA-2.4-14), so a change to the v1 protocol shows up here.
   */
  const SYSTEM_PROMPT_1FC94A3 = { sha256: "56854f788c0d1d22fad12c9425fdd33e4947b1683be0a9a877787ba5bd911409", length: 6357 } as const;

  it.each([
    ["no routing block", null],
    ["an empty routing block", {}],
    ["engine enforce (ignored on v1)", { engine: "enforce" }],
    ["advise with profile and margin", { engine: "advise", profile: "safe", margin: 0.5 }],
    ["roles: {}", { roles: {} }],
    ["advisor disabled", { advisor: { enabled: false } }],
    ["classifier rules", { classifier: { backend: "rules" } }],
  ] as const)("without an explicit routing.roles (%s) the whole output.system is what 1fc94a3 produced: one part with the pinned SHA-256", async (_name, routing) => {
    invalidateConfigCache();
    const { hooks, agentsCall } = await plugin(routing as Record<string, unknown> | null);
    const system = await turn(hooks);
    expect(system).toHaveLength(1); // the whole array, not just its first part
    expect(system.map((part) => ({ sha256: sha(part), length: part.length }))).toEqual([SYSTEM_PROMPT_1FC94A3]);
    expect(system[0]).toBe(baseline()); // and the current assembleSystemPrompt agrees with that commit's output
    expect(agentsCall).not.toHaveBeenCalled(); // the agent list is not even fetched
  });
  it("a configured class whose agents are all unusable leaves the line as shipped", async () => {
    const { hooks, agentsCall } = await plugin({ roles: { search: ["build", "missing", "ghost", "fast"], debug: ["title", "compaction"] } });
    await turn(hooks);
    await until(() => agentsCall.mock.calls.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 30)); // let the background refresh land
    expect((await turn(hooks))[0]).toBe(baseline());
  });

  it("QA-2.4-13: a turn never waits for the agent list: the first turn is the baseline, even when the list never arrives", async () => {
    const { hooks, agentsCall } = await plugin({ roles: { search: ["explore"] } }, () => new Promise<never>(() => undefined));
    const first = await Promise.race([turn(hooks), new Promise<"waited">((resolve) => setTimeout(() => resolve("waited"), 1_000))]);
    expect(first).not.toBe("waited"); // the turn finished without the list
    expect((first as string[])[0]).toBe(baseline());
    expect(agentsCall).toHaveBeenCalledTimes(1); // the refresh was started in the background
    expect((await turn(hooks))[0]).toBe(baseline()); // still pending: still the baseline, still not waiting
    expect(agentsCall).toHaveBeenCalledTimes(1); // and not started a second time while one is in flight
  });

  it("QA-2.4-13: the first list arrives in the background and the next turn has the roles; the list is cached between turns", async () => {
    const working = await plugin({ roles: { search: ["explore"] } });
    expect((await turn(working.hooks, "a"))[0]).toBe(baseline()); // the first turn has no list yet
    const prompt = await withRoles(working.hooks);
    expect(rLine(prompt)).toContain("by class: search→@explore");
    await turn(working.hooks, "b");
    expect(working.agentsCall).toHaveBeenCalledTimes(1);
  });

  it("QA-2.4-13: a stale list keeps being served while the refresh is under way, and a failed refresh keeps it", async () => {
    let clock = 1_000_000;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      let mode: "list" | "hang" | "fail" = "list";
      const { hooks, agentsCall } = await plugin({ roles: { search: ["explore"] } }, () => (mode === "hang" ? new Promise<never>(() => undefined) : mode === "fail" ? Promise.reject(new Error("endpoint down")) : Promise.resolve({ data: AGENTS })));
      await turn(hooks);
      const withList = await withRoles(hooks);
      expect(rLine(withList)).toContain("search→@explore");
      mode = "hang";
      clock += 61_000; // due: a refresh starts, the old list is served at once
      const during = await Promise.race([turn(hooks), new Promise<"waited">((resolve) => setTimeout(() => resolve("waited"), 1_000))]);
      expect(during).not.toBe("waited");
      expect((during as string[])[0]).toBe(withList);
      expect(agentsCall).toHaveBeenCalledTimes(2);
      // a failing refresh (after the hanging one is abandoned by its own timeout) keeps the list too
      const failing = await plugin({ roles: { search: ["explore"] } }, () => (mode === "fail" ? Promise.reject(new Error("endpoint down")) : Promise.resolve({ data: AGENTS })));
      mode = "list";
      await turn(failing.hooks);
      expect(rLine(await withRoles(failing.hooks))).toContain("search→@explore");
      mode = "fail";
      clock += 61_000;
      await turn(failing.hooks); // starts the refresh that fails
      await until(() => failing.logs.some((m) => m.includes("agent list is unavailable")));
      expect(rLine((await turn(failing.hooks))[0]!)).toContain("search→@explore"); // the last list survives the failure
    } finally {
      spy.mockRestore();
    }
  });

  it("an unavailable agent list is logged and the prompt stays the baseline", async () => {
    const failing = await plugin({ roles: { search: ["explore"] } }, async () => { throw new Error("agents endpoint down"); });
    await turn(failing.hooks);
    await until(() => failing.logs.some((m) => m.includes("agent list is unavailable")));
    expect((await turn(failing.hooks))[0]).toBe(baseline());
  });

  it("a malformed agent list (no data array) leaves the baseline", async () => {
    const { hooks, agentsCall } = await plugin({ roles: { search: ["explore"] } }, async () => ({ data: "nope" }));
    await turn(hooks);
    await until(() => agentsCall.mock.calls.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 30));
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
