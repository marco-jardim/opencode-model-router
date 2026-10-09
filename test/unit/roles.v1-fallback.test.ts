/**
 * #84 P3.1 T3.1.2 (plan §2.7, I8): on OpenCode v1 the roles configuration is validated but inert. With every roles key set
 * (`routing.delegation: "roles"`, `routing.workRoots`, `routing.exploration`, `routing.run`, `roleAgents`) the v1 plugin registers
 * no role agent, no `router_run` / `router_request_authority` tool and no roles protocol, logs ONE notice, and its system prompt,
 * agent/command config, tool set (names, descriptions and argument JSON schemas) and hook set hash-equal the BASE (computed in-test,
 * both on the v1 host path: `ModelRouterPlugin` without `routerHost`, the shape `roles.runtime.test.ts` and `plugin-agents-v1.test.ts`
 * use).
 *
 * "Base" here = the SAME code (this HEAD) with the SAME configuration minus the roles keys — it proves the roles keys change nothing
 * on v1. That this HEAD's v1 surface equals the code BEFORE #84 is proved by the pinned goldens and hashes that #84 left unchanged
 * (`git diff eeab36b -- test/golden` lists only the new roles golden): test/golden/{assembled-prompt, protocol, prompt-style,
 * narration, tier-prompts, fable-effort-preset, banners}.golden.test.ts with their __snapshots__, test/integration/v1-roles-line.test.ts
 * (the whole v1 `output.system` against the SHA-256 of commit 1fc94a3, only the documented #77/#83 deltas inverted) and
 * test/unit/prompt-measurement.test.ts. The real-host side (`npm run smoke:v1` with OpenCode 1.x) is in docs/qa/role-tier/phase-p31.md.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { tool as pluginTool } from "@opencode-ai/plugin";
import ModelRouterPlugin from "../../src/index";
import type { RouterPluginInput } from "../../src/compat/child-session";
import { invalidateConfigCache, overridePath, resetRolesWarnings } from "../../src/router/config";
import { SHIPPED_ROLE_SPECS } from "../../src/router/roles";
import { ROLES_V1_NOTICE } from "../../src/router/roles-config";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  invalidateConfigCache();
  resetRolesWarnings();
});

/** One HOME for both configurations, so nothing that embeds a path can differ between them. */
function home(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "omr-p31-v1-")));
  temps.push(dir);
  vi.stubEnv("HOME", dir);
  vi.stubEnv("USERPROFILE", dir);
  vi.stubEnv("MODEL_ROUTER_ENFORCE", "");
  return dir;
}

/** JSON with sorted object keys; functions and symbols become stable markers (a tool's `execute`, zod internals). */
function stable(value: unknown, seen = new WeakSet<object>()): string {
  if (typeof value === "function") return JSON.stringify("[function]");
  if (typeof value === "symbol" || typeof value === "bigint") return JSON.stringify(String(value));
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (seen.has(value)) return JSON.stringify("[cycle]");
  seen.add(value);
  const out = Array.isArray(value)
    ? `[${value.map((v) => stable(v, seen)).join(",")}]`
    : `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k], seen)}`).join(",")}}`;
  seen.delete(value);
  return out;
}
const sha = (value: unknown): string => createHash("sha256").update(stable(value), "utf8").digest("hex");
/**
 * The JSON schema of a tool's arguments (the plugin SDK's zod, `toJSONSchema`): types, constraints and descriptions, so a changed
 * argument type or bound changes the hash, not only a renamed argument (QA-P31-1-4).
 */
function argsSchema(args: Record<string, unknown> | undefined): unknown {
  try {
    return pluginTool.schema.toJSONSchema(pluginTool.schema.object((args ?? {}) as Record<string, any>), { unrepresentable: "any" });
  } catch (error) {
    return { unrepresentable: String(error) };
  }
}

interface V1Surface {
  /** `experimental.chat.system.transform` for a root session. */
  system: string[];
  /** The opencode config object after the plugin's v1 `config` hook (agents, commands, …). */
  config: Record<string, unknown>;
  /** Every registered tool: name, description, argument names and the arguments' JSON schema (QA-P31-1-4). */
  tools: Array<{ name: string; description: string; args: string[]; schema: unknown }>;
  /** The plugin's hook names. */
  hooks: string[];
  /** Log lines (client.app.log and console.warn) that carry the v1 roles notice. */
  notices: number;
}

/** Writes `override` as the global override and loads the v1 plugin (no `routerHost`): what a v1 host would see. */
async function v1Surface(dir: string, override: Record<string, unknown>): Promise<V1Surface> {
  mkdirSync(dirname(overridePath()), { recursive: true });
  writeFileSync(overridePath(), JSON.stringify(override));
  invalidateConfigCache();
  resetRolesWarnings();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const log = vi.fn(async () => ({}));
  const hooks = await ModelRouterPlugin({
    directory: dir, worktree: dir,
    client: {
      session: { get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id, ...(path.id === "root" ? {} : { parentID: "root" }) } }) },
      app: { log },
    },
  } as unknown as RouterPluginInput) as Record<string, any>;
  try {
    const config: Record<string, unknown> = {};
    await hooks.config?.(config);
    const output = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "root", model: { providerID: "openai", modelID: "gpt-x" } }, output);
    const tools = Object.entries((hooks.tool ?? {}) as Record<string, { description?: unknown; args?: Record<string, unknown> }>)
      .map(([name, tool]) => ({ name, description: String(tool?.description ?? ""), args: Object.keys(tool?.args ?? {}).sort(), schema: argsSchema(tool?.args) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    await hooks.dispose?.();
    const notices = [...log.mock.calls, ...warn.mock.calls].filter((call) => JSON.stringify(call).includes(ROLES_V1_NOTICE)).length;
    return { system: output.system, config, tools, hooks: Object.keys(hooks).sort(), notices };
  } finally {
    warn.mockRestore();
  }
}

const BASE = { routing: { engine: "static" } };
const rolesOverride = (dir: string) => ({
  routing: {
    engine: "static",
    delegation: "roles",
    workRoots: [`${dir.replaceAll("\\", "/")}/wt-*`],
    exploration: { rate: 0.1 },
    run: { scripts: ["test", "typecheck"] },
  },
  roleAgents: { explorer: { budget: { fast: 10 } }, researcher: { enabled: false } },
});
const ROLE_NAMES = SHIPPED_ROLE_SPECS.map((spec) => spec.agent);

describe("roles configuration on OpenCode v1 (T3.1.2, plan §2.7, I8)", () => {
  it("registers nothing: no role agent, no router_run / router_request_authority, no roles protocol; exactly one notice", async () => {
    const dir = home();
    const base = await v1Surface(dir, BASE);
    const roles = await v1Surface(dir, rolesOverride(dir));
    const agents = (surface: V1Surface) => Object.keys((surface.config.agent ?? {}) as Record<string, unknown>);
    // No shipped role agent beyond what the base itself has (the v1 config hook adds the tier agents only).
    expect(agents(roles).filter((name) => ROLE_NAMES.includes(name))).toEqual(agents(base).filter((name) => ROLE_NAMES.includes(name)));
    expect(agents(roles).filter((name) => ROLE_NAMES.includes(name) && name !== "general")).toEqual([]);
    expect(agents(roles).length).toBeGreaterThan(0); // the tier agents are there: the surface is not vacuous
    // No role tool.
    const toolNames = roles.tools.map((tool) => tool.name);
    expect(toolNames).not.toContain("router_run");
    expect(toolNames).not.toContain("router_request_authority");
    expect(toolNames.length).toBeGreaterThan(0);
    // The schemas are real: at least one tool has typed properties (not an unrepresentable fallback).
    expect(roles.tools.some((tool) => Object.keys((tool.schema as { properties?: object } | undefined)?.properties ?? {}).length > 0)).toBe(true);
    expect(roles.tools.filter((tool) => "unrepresentable" in ((tool.schema ?? {}) as object)).map((tool) => tool.name)).toEqual([]);
    // The tiers protocol, never the roles protocol.
    expect(roles.system.length).toBeGreaterThan(0);
    expect(roles.system.join("\n")).not.toContain("Roles:");
    expect(roles.system.join("\n")).toMatch(/Tiers: @fast=/);
    // One notice for the roles configuration, none for the base.
    expect(roles.notices).toBe(1);
    expect(base.notices).toBe(0);
  });

  it("the v1 system prompt, agent/command config, tool set and hook set hash-equal the same config without the roles keys", async () => {
    const dir = home();
    const base = await v1Surface(dir, BASE);
    const roles = await v1Surface(dir, rolesOverride(dir));
    const hashes = (surface: V1Surface) => ({
      system: sha(surface.system), config: sha(surface.config), tools: sha(surface.tools), hooks: sha(surface.hooks),
    });
    expect(hashes(roles)).toEqual(hashes(base));
    // Byte equality of the prompt too (the hash above would hide nothing, this names the difference if there is one).
    expect(roles.system).toEqual(base.system);
  });
});
